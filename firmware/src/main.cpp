#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <Wire.h>
#include <atomic>
#include "esp_heap_caps.h"
#include "driver/i2s_std.h"
#include "oled_scene.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

namespace {
U8G2_SSD1306_128X64_NONAME_F_HW_I2C ssd(U8G2_R0, U8X8_PIN_NONE, OLED_SCL, OLED_SDA);
U8G2_SH1106_128X64_NONAME_F_HW_I2C sh(U8G2_R0, U8X8_PIN_NONE, OLED_SCL, OLED_SDA);
U8G2* oled = OLED_IS_SH1106 ? static_cast<U8G2*>(&sh) : static_cast<U8G2*>(&ssd);
i2s_chan_handle_t amplifier = nullptr;
constexpr uint32_t DMA_DESCRIPTORS = 8, DMA_FRAMES = 256;
QueueHandle_t downloadQueue, audioQueue, resultQueue, displayQueue;
TaskHandle_t displayWorker = nullptr;
std::atomic<uint8_t> audioLevel{0};
std::atomic<uint32_t> audioLevelAt{0};
std::atomic<OledScene::Phase> scenePhase{OledScene::Phase::Idle};
std::atomic<bool> cancelPlayback{false}, audioBusy{false};
std::atomic<int> volume{70};
std::atomic<uint32_t> epoch{0}, firstSampleAt{0}, playedParts{0};
std::atomic<uint32_t> firstDownloadElapsedMs{UINT32_MAX};
portMUX_TYPE firstDownloadMux = portMUX_INITIALIZER_UNLOCKED;
std::atomic<size_t> bufferedBytes{0};
std::atomic<bool> waitingForAudio{true}, pipelineFailed{false};
char pipelineError[120] = {};
uint32_t acceptedAt = 0;
bool displayReady = false;
bool leaseLost = false;
char displayText[1300] = {}, headerText[40] = "Starting...";
size_t pageStart[400] = {};
uint16_t pageCount = 1, page = 0;
uint32_t pageAt = 0;
struct PlayJob { char id[40], lease[40], manifest[160], text[1300]; };
struct DownloadPart { uint32_t epoch, index; bool end; char path[128]; };
struct AudioPart { uint32_t epoch, index, rate; uint8_t* data; size_t size; bool end; };
struct PlayResult { bool ok; bool cancelled; char error[120]; };
struct DisplayState { char text[1300]; char heading[40]; OledScene::Theme theme = OledScene::Theme::Buddy; };
PlayJob active{};
DisplayState requestedDisplay{}; // Only the Arduino loop writes this snapshot.
String lastFinishedId;
OledScene::Theme displayTheme = OledScene::Theme::Buddy;
OledScene::Phase displayPhase = OledScene::Phase::Idle;
uint32_t phaseSince = 0;
uint8_t previousFrame[1024] = {};
bool previousFrameValid = false;
std::atomic<uint32_t> oledFrameCount{0}, oledPayloadBytes{0}, oledMaxFlushUs{0};
uint32_t jobOledFrames = 0, jobOledBytes = 0;

void wakeDisplay() { if (displayWorker) xTaskNotifyGive(displayWorker); }
void setScenePhase(OledScene::Phase phase) { if (scenePhase.exchange(phase) != phase) wakeDisplay(); }

const char* phaseTitle(OledScene::Phase phase) {
  switch (phase) {
    case OledScene::Phase::Queued: return "IN QUEUE";
    case OledScene::Phase::Thinking: return "THINKING";
    case OledScene::Phase::Buffering: return "BUFFERING";
    case OledScene::Phase::Playing: return volume.load() ? "SPEAKING" : "MUTED";
    case OledScene::Phase::Finished: return "ALL DONE";
    case OledScene::Phase::Stopped: return "STOPPED";
    case OledScene::Phase::Error: return "OOPS";
    default: return "READY";
  }
}

OledScene::Theme parseTheme(const char* mode) {
  return !strcmp(mode, "wave") ? OledScene::Theme::Wave :
         !strcmp(mode, "text") ? OledScene::Theme::Text : OledScene::Theme::Buddy;
}

String baseUrl() { return String("http://") + SERVER_HOST + ":" + SERVER_PORT; }
String devicePath(const char* action) { return String("/api/device/") + DEVICE_ID + "/" + action; }

bool decodeUtf8(const char* text, size_t size, size_t& index, uint32_t& cp) {
  if (index >= size) return false;
  const uint8_t first = static_cast<uint8_t>(text[index++]);
  if (first < 0x80) { cp = first; return true; }
  const int extra = (first & 0xE0) == 0xC0 ? 1 : (first & 0xF0) == 0xE0 ? 2 : (first & 0xF8) == 0xF0 ? 3 : 0;
  if (!extra) { cp = '?'; return true; }
  cp = first & ((1 << (6 - extra)) - 1);
  for (int i = 0; i < extra; ++i) {
    if (index >= size || (static_cast<uint8_t>(text[index]) & 0xC0) != 0x80) { cp = '?'; return true; }
    cp = (cp << 6) | (static_cast<uint8_t>(text[index++]) & 0x3F);
  }
  return true;
}

size_t layout(size_t start, bool draw) {
  const auto box = OledScene::textBox(displayTheme);
  const size_t size = strlen(displayText);
  size_t index = start;
  int x = box.x, line = 0;
  oled->setFont(u8g2_font_wqy12_t_gb2312);
  while (index < size) {
    const size_t before = index;
    uint32_t cp;
    if (!decodeUtf8(displayText, size, index, cp)) break;
    if (cp == '\r') continue;
    if (cp == '\n') { x = box.x; if (++line == box.rows) return index; continue; }
    const uint16_t glyph = cp <= 0xFFFF && u8g2_IsGlyph(oled->getU8g2(), cp) ? cp : '?';
    int width = u8g2_GetGlyphWidth(oled->getU8g2(), glyph);
    if (width <= 0) width = 6;
    if (x + width > box.x + box.width) { x = box.x; if (++line == box.rows) return before; }
    if (draw) oled->drawGlyph(x, box.y + 13 + box.line_height * line, glyph);
    x += width;
  }
  return index;
}

void flushChangedTiles() {
  const uint32_t started = micros();
  uint32_t payload = 0;
  const uint8_t* buffer = oled->getBufferPtr();
  if (!previousFrameValid) {
    oled->sendBuffer(); previousFrameValid = true;
    payload = sizeof(previousFrame);
  } else {
    // Full-buffer R0: each 8x8 tile occupies eight bytes. Send only changed
    // spans, so a speaking mouth does not retransmit the unchanged paragraph.
    for (uint8_t row = 0; row < 8; ++row) {
      uint8_t first = 16, last = 0;
      for (uint8_t col = 0; col < 16; ++col) {
        const size_t offset = (row * 16 + col) * 8;
        if (memcmp(buffer + offset, previousFrame + offset, 8)) {
          first = min(first, col); last = col;
        }
      }
      if (first != 16) {
        oled->updateDisplayArea(first, row, last - first + 1, 1);
        payload += (last - first + 1) * 8;
      }
    }
  }
  memcpy(previousFrame, buffer, sizeof(previousFrame));
  if (payload) {
    oledFrameCount.fetch_add(1); oledPayloadBytes.fetch_add(payload);
    const uint32_t elapsed = micros() - started;
    uint32_t maximum = oledMaxFlushUs.load();
    while (elapsed > maximum && !oledMaxFlushUs.compare_exchange_weak(maximum, elapsed)) {}
  }
}

OledScene::Phase effectivePhase() {
  if (audioBusy.load()) {
    if (pipelineFailed.load()) return OledScene::Phase::Error;
    if (cancelPlayback.load()) return OledScene::Phase::Stopped;
    if (firstSampleAt.load()) {
      // Keep the mouth active through the short DMA tail, then show buffering
      // only when no PCM has been accepted for longer than the audio ring.
      return waitingForAudio.load() && millis() - audioLevelAt.load() > 120 ?
          OledScene::Phase::Buffering : OledScene::Phase::Playing;
    }
  }
  return scenePhase.load();
}

void render() {
  if (!displayReady) return;
  const uint32_t now = millis();
  const auto phase = effectivePhase();
  if (phase != displayPhase) { displayPhase = phase; phaseSince = now; }
  uint8_t level = audioLevel.load();
  if (volume.load() == 0 || now - audioLevelAt.load() > 160 || phase != OledScene::Phase::Playing) level = 0;
  oled->clearBuffer();
  oled->setFont(u8g2_font_5x8_tf);
  oled->drawStr(0, 8, phaseTitle(phase));
  char counter[20]; snprintf(counter, sizeof(counter), "%u/%u", page + 1, pageCount);
  oled->drawStr(128 - oled->getStrWidth(counter), 8, counter);
  oled->drawHLine(0, 12, 128);
  OledScene::draw(*oled, {displayTheme, phase, level, now, phaseSince});
  layout(pageStart[page], true);
  flushChangedTiles();
}

void applyDisplay(const DisplayState& state) {
  strlcpy(headerText, state.heading, sizeof(headerText));
  if (!strcmp(displayText, state.text) && displayTheme == state.theme) return;
  displayTheme = state.theme;
  strlcpy(displayText, state.text, sizeof(displayText));
  pageCount = 1; pageStart[0] = 0; page = 0;
  const size_t size = strlen(displayText);
  size_t cursor = 0;
  while (cursor < size && pageCount < 400) {
    const size_t next = layout(cursor, false);
    if (next <= cursor || next >= size) break;
    pageStart[pageCount++] = next;
    cursor = next;
  }
  pageAt = millis();
}

void queueDisplay() {
  // The full framebuffer takes about 100ms at 100kHz. A separate worker keeps
  // this I2C transfer off the manifest/download path, including the first task.
  if (displayQueue) { xQueueOverwrite(displayQueue, &requestedDisplay); wakeDisplay(); }
  else { applyDisplay(requestedDisplay); render(); } // Startup, before worker creation.
}

void show(const char* text, const char* heading) {
  strlcpy(requestedDisplay.text, text, sizeof(requestedDisplay.text));
  strlcpy(requestedDisplay.heading, heading, sizeof(requestedDisplay.heading));
  queueDisplay();
}

void showHeading(const char* heading) {
  if (!strcmp(requestedDisplay.heading, heading)) return;
  strlcpy(requestedDisplay.heading, heading, sizeof(requestedDisplay.heading));
  queueDisplay();
}

void displayTask(void*) {
  DisplayState state;
  uint32_t renderedAt = 0;
  uint32_t speechEpoch = UINT32_MAX;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
    const bool changed = xQueueReceive(displayQueue, &state, 0) == pdTRUE;
    if (changed) applyDisplay(state);
    const uint32_t now = millis();
    if (audioBusy.load() && firstSampleAt.load() && speechEpoch != epoch.load()) {
      speechEpoch = epoch.load(); page = 0; pageAt = now;
    }
    if (pageCount > 1 && millis() - pageAt > 3000) {
      page = (page + 1) % pageCount; pageAt = now;
    }
    if (changed || effectivePhase() != displayPhase || now - renderedAt >= 125) {
      renderedAt = now; render(); // No catch-up queue; animation is <=8fps.
    }
  }
}

void initOled() {
  Wire.begin(OLED_SDA, OLED_SCL);
  Wire.setTimeOut(100);
  for (uint8_t address : {0x3C, 0x3D}) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      oled->setI2CAddress(address << 1); oled->setBusClock(100000); oled->begin();
      displayReady = true;
      show("本地语音实验室\n正在连接无线网络", "Qwen Voice Lab");
      Serial.printf("OLED SDA=%d SCL=%d address=0x%02X\n", OLED_SDA, OLED_SCL, address);
      return;
    }
  }
  Serial.println("OLED not detected. Check SDA=8 / SCL=9 and 3.3V supply.");
}

bool initAudio() {
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel.dma_desc_num = DMA_DESCRIPTORS; channel.dma_frame_num = DMA_FRAMES;
  channel.auto_clear_after_cb = true; // Silence instead of replaying stale DMA samples on underrun.
  if (i2s_new_channel(&channel, &amplifier, nullptr) != ESP_OK) return false;
  i2s_std_config_t config{};
  config.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(24000);
  config.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  config.gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = static_cast<gpio_num_t>(AMP_BCLK),
    .ws = static_cast<gpio_num_t>(AMP_LRC), .dout = static_cast<gpio_num_t>(AMP_DIN), .din = I2S_GPIO_UNUSED,
    .invert_flags = {false, false, false}};
  return i2s_channel_init_std_mode(amplifier, &config) == ESP_OK;
}


bool requestJson(const String& path, JsonDocument& response, const String* payload = nullptr) {
  // Only the Arduino loop calls this helper. Keep its connection independent
  // from the audio downloader and reuse it for manifests and heartbeats.
  static WiFiClient client;
  static HTTPClient http;
  http.setTimeout(2200); http.setConnectTimeout(1500); http.setReuse(true);
  if (!http.begin(client, baseUrl() + path)) return false;
  if (client.connected()) client.setNoDelay(true);
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  const int status = payload ? (http.addHeader("Content-Type", "application/json"), http.POST(*payload)) : http.GET();
  if (status == 409) leaseLost = true;
  const bool ok = status == 200 && !deserializeJson(response, http.getString());
  if (client.connected()) client.setNoDelay(true);
  if (!ok) Serial.printf("HTTP %s -> %d\n", path.c_str(), status);
  // Do not reuse a partially read or failed response on the next request.
  if (!ok) http.setReuse(false);
  http.end(); return ok;
}

bool heartbeat(const char* state, const char* error = "") {
  JsonDocument body, response;
  body["status"] = state;
  if (active.id[0]) {
    body["job_id"] = active.id; body["lease"] = active.lease;
    body["played_parts"] = playedParts.load();
    const uint32_t first = firstSampleAt.load();
    if (first) { body["first_audio"] = true; body["first_audio_elapsed_ms"] = first - acceptedAt; }
    const uint32_t downloaded = firstDownloadElapsedMs.load();
    if (downloaded != UINT32_MAX) body["first_download_elapsed_ms"] = downloaded;
  }
  if (error[0]) body["error"] = error;
  String payload; serializeJson(body, payload);
  if (!requestJson(devicePath("heartbeat"), response, &payload)) {
    if (leaseLost) { leaseLost = false; cancelPlayback.store(true); return true; }
    return false;
  }
  volume.store(constrain(response["volume"] | 70, 0, 100));
  if (response["cancel"] | false) cancelPlayback.store(true);
  return true;
}

bool cancelled(uint32_t generation) { return cancelPlayback.load() || generation != epoch.load(); }

struct AudioReadTrace {
  bool retryable = false;
  const char* reason = "invalid WAV";
  size_t expected = 0, received = 0;
  uint8_t prefix[12] = {};
};

bool readExact(WiFiClient& stream, uint8_t* target, size_t length, uint32_t generation, AudioReadTrace* trace = nullptr) {
  size_t offset = 0; uint32_t lastData = millis();
  while (offset < length && !cancelled(generation)) {
    const int available = stream.available();
    if (available > 0) {
      const int count = stream.read(target + offset, min(length - offset, static_cast<size_t>(available)));
      if (count > 0) { offset += count; lastData = millis(); continue; }
    }
    const bool connected = stream.connected();
    if (!connected || millis() - lastData > 8000) {
      if (trace) {
        trace->retryable = true;
        trace->reason = connected ? "read timeout" : "stream disconnected";
        trace->expected = length; trace->received = offset;
      }
      return false;
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
  return offset == length;
}
uint16_t le16(const uint8_t* p) { return p[0] | (uint16_t(p[1]) << 8); }
uint32_t le32(const uint8_t* p) { return p[0] | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }
bool skipBytes(WiFiClient& stream, uint32_t size, uint32_t generation, AudioReadTrace* trace) {
  uint8_t discard[256];
  while (size) { const size_t count = min(size, uint32_t(sizeof(discard))); if (!readExact(stream, discard, count, generation, trace)) return false; size -= count; }
  return true;
}

bool wavHeader(WiFiClient& stream, uint32_t& rate, uint32_t& bytes, uint32_t generation, AudioReadTrace& trace) {
  uint8_t header[16] = {};
  const bool prefixRead = readExact(stream, header, 12, generation, &trace);
  memcpy(trace.prefix, header, sizeof(trace.prefix));
  if (!prefixRead) return false;
  if (memcmp(header, "RIFF", 4) || memcmp(header + 8, "WAVE", 4)) {
    trace.reason = "invalid RIFF header";
    return false;
  }
  bool formatSeen = false;
  for (int chunks = 0; chunks < 30; ++chunks) {
    if (!readExact(stream, header, 8, generation, &trace)) return false;
    const uint32_t size = le32(header + 4);
    if (!memcmp(header, "fmt ", 4)) {
      if (size < 16 || size > 4096 || !readExact(stream, header, 16, generation, &trace)) return false;
      rate = le32(header + 4);
      if (le16(header) != 1 || le16(header + 2) != 1 || le16(header + 14) != 16 || le16(header + 12) != 2 || rate < 8000 || rate > 48000) return false;
      formatSeen = true;
      if (!skipBytes(stream, size - 16 + (size & 1), generation, &trace)) return false;
    } else if (!memcmp(header, "data", 4)) {
      // Buffer one bounded segment, never the entire long utterance.
      if (!formatSeen || size == 0 || size > 4 * 1024 * 1024 || (size & 1)) return false;
      bytes = size; return true;
    } else {
      if (size > 65536 || !skipBytes(stream, size + (size & 1), generation, &trace)) return false;
    }
  }
  return false;
}

void releasePart(AudioPart& part) {
  if (part.data) { free(part.data); bufferedBytes.fetch_sub(part.size); part.data = nullptr; }
}

void failPipeline(uint32_t generation, const char* message) {
  if (generation != epoch.load() || cancelPlayback.load()) return;
  strlcpy(pipelineError, message, sizeof(pipelineError));
  pipelineFailed.store(true); cancelPlayback.store(true);
  audioLevel.store(0); wakeDisplay();
}

void downloadTask(void*) {
  DownloadPart request;
  WiFiClient client; HTTPClient http;
  // Audio segments are immutable. Use a fresh connection per attempt rather
  // than retaining a possibly closed/NAT-expired socket between segments.
  http.setReuse(false); http.setTimeout(8000); http.setConnectTimeout(3000);
  for (;;) {
    if (xQueueReceive(downloadQueue, &request, portMAX_DELAY) != pdTRUE) continue;
    if (cancelled(request.epoch)) continue;
    AudioPart part{}; part.epoch = request.epoch; part.index = request.index; part.end = request.end;
    if (!request.end) {
      const uint32_t downloadStarted = millis();
      const char* failureStage = "HTTP begin";
      int httpStatus = 0;
      uint32_t bytes = 0;
      bool ok = false;
      unsigned attempt = 0;
      AudioReadTrace trace;
      for (attempt = 1; attempt <= 3 && !cancelled(request.epoch); ++attempt) {
        trace = AudioReadTrace{};
        trace.reason = "HTTP begin failed";
        failureStage = "HTTP begin"; httpStatus = 0; bytes = 0;
        part.rate = 0; part.size = 0;
        client.stop();
        ok = http.begin(client, baseUrl() + request.path);
        if (ok) {
          failureStage = "HTTP response";
          trace.reason = "HTTP response failed";
          http.addHeader("X-Device-Token", DEVICE_TOKEN);
          httpStatus = http.GET(); ok = httpStatus == 200;
          trace.retryable = httpStatus < 0 || httpStatus == 408 || httpStatus == 429 || httpStatus >= 500;
        }
        WiFiClient* stream = nullptr;
        if (ok) {
          failureStage = "WAV header";
          trace = AudioReadTrace{};
          stream = http.getStreamPtr();
          if (stream) ok = wavHeader(*stream, part.rate, bytes, request.epoch, trace);
          else { ok = false; trace.retryable = true; trace.reason = "missing HTTP stream"; }
        }
        if (ok) {
          // Keep only a complete bounded segment. Failed attempts are freed
          // before retry, and no partial PCM is ever sent to playback.
          const size_t budget = 2 * 1024 * 1024;
          while (!cancelled(request.epoch) && bufferedBytes.load() > (bytes > budget ? 0 : budget - bytes)) vTaskDelay(pdMS_TO_TICKS(5));
          if (!cancelled(request.epoch)) {
            failureStage = "PCM allocation";
            trace.reason = "PCM allocation failed"; trace.retryable = false;
            part.size = bytes;
            part.data = static_cast<uint8_t*>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
            if (!part.data && bytes <= 65536) part.data = static_cast<uint8_t*>(malloc(bytes));
            if (part.data) {
              failureStage = "PCM body";
              bufferedBytes.fetch_add(bytes);
              ok = readExact(*stream, part.data, bytes, request.epoch, &trace);
            } else ok = false;
          } else ok = false;
        }
        http.end();
        client.stop();
        if (ok) break;
        releasePart(part);
        if (cancelled(request.epoch) || !trace.retryable || attempt == 3) break;
        const uint32_t retryAt = millis();
        while (!cancelled(request.epoch) && millis() - retryAt < attempt * 150) {
          vTaskDelay(pdMS_TO_TICKS(10));
        }
      }
      const uint32_t downloadElapsed = millis() - downloadStarted;
      if (!ok) {
        releasePart(part);
        if (!cancelled(request.epoch)) {
          const char* detail = "音频文件格式不支持，请重新生成音频";
          if (httpStatus == 401 || httpStatus == 403) detail = "设备认证失败，请检查设备令牌";
          else if (httpStatus == 404) detail = "音频文件不存在，请重新生成音频";
          else if (!strcmp(failureStage, "PCM allocation")) detail = "音频缓冲分配失败，请检查PSRAM";
          else if (trace.retryable) detail = "音频下载中断或超时，重试仍失败，请检查网络";
          else if (httpStatus != 200) detail = "音频请求失败，请检查电脑服务和网络";
          Serial.printf("[AUDIO] part=%lu attempts=%u stage=%s reason=%s HTTP=%d PCM=%lu read=%lu/%lu free_heap=%lu free_psram=%lu RSSI=%d IP=%s header=%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x\n",
            static_cast<unsigned long>(request.index), attempt, failureStage, trace.reason, httpStatus,
            static_cast<unsigned long>(bytes), static_cast<unsigned long>(trace.received), static_cast<unsigned long>(trace.expected),
            static_cast<unsigned long>(ESP.getFreeHeap()), static_cast<unsigned long>(ESP.getFreePsram()), WiFi.RSSI(), WiFi.localIP().toString().c_str(),
            trace.prefix[0], trace.prefix[1], trace.prefix[2], trace.prefix[3], trace.prefix[4], trace.prefix[5],
            trace.prefix[6], trace.prefix[7], trace.prefix[8], trace.prefix[9], trace.prefix[10], trace.prefix[11]);
          failPipeline(request.epoch, detail);
        }
        continue;
      }
      if (request.index == 1) {
        // Cancellation may leave an old download finishing while a new task is
        // accepted. Guard the epoch check and metric reset/update together.
        portENTER_CRITICAL(&firstDownloadMux);
        if (request.epoch == epoch.load() && firstDownloadElapsedMs.load() == UINT32_MAX)
          firstDownloadElapsedMs.store(downloadElapsed);
        portEXIT_CRITICAL(&firstDownloadMux);
      }
    }
    bool queued = false;
    while (!cancelled(request.epoch) && !(queued = xQueueSend(audioQueue, &part, pdMS_TO_TICKS(20)) == pdTRUE)) {}
    if (!queued) releasePart(part);
  }
}

void playbackTask(void*) {
  uint32_t seenEpoch = 0, finishedEpoch = UINT32_MAX, rate = 0;
  bool enabled = false, rebuildAudio = false;
  int16_t stereo[2048];
  for (;;) {
    uint32_t generation = epoch.load();
    if (seenEpoch != generation) {
      if (enabled) { i2s_channel_disable(amplifier); rebuildAudio = true; }
      enabled = false; rate = 0; seenEpoch = generation;
      audioLevel.store(0);
    }
    if (audioBusy.load() && cancelPlayback.load() && finishedEpoch != generation) {
      if (enabled) i2s_channel_disable(amplifier);
      enabled = false; rebuildAudio = true;
      audioLevel.store(0); wakeDisplay();
      PlayResult result{}; result.cancelled = !pipelineFailed.load();
      if (pipelineFailed.load()) strlcpy(result.error, pipelineError, sizeof(result.error));
      xQueueSend(resultQueue, &result, portMAX_DELAY); finishedEpoch = generation;
    }
    AudioPart part{};
    if (xQueueReceive(audioQueue, &part, pdMS_TO_TICKS(15)) != pdTRUE) { waitingForAudio.store(true); continue; }
    // Task acceptance can change epoch while xQueueReceive is blocked. Re-read
    // it before comparing or the first cached chunk of a new task can be lost.
    generation = epoch.load();
    if (seenEpoch != generation) {
      if (enabled) { i2s_channel_disable(amplifier); rebuildAudio = true; }
      enabled = false; rate = 0; seenEpoch = generation;
    }
    if (part.epoch != generation || cancelled(generation) || finishedEpoch == generation) { releasePart(part); continue; }
    if (part.end) {
      // One channel stays enabled across all segments; no 100ms per-part tail.
      if (enabled) {
        const uint32_t drainMs = (DMA_DESCRIPTORS * DMA_FRAMES * 1000 + rate - 1) / rate + 2;
        const uint32_t drainAt = millis();
        while (!cancelled(generation) && millis() - drainAt < drainMs) vTaskDelay(pdMS_TO_TICKS(2));
        i2s_channel_disable(amplifier); enabled = false;
        if (cancelled(generation)) rebuildAudio = true;
      }
      PlayResult result{}; result.cancelled = cancelled(generation); result.ok = !result.cancelled;
      xQueueSend(resultQueue, &result, portMAX_DELAY); finishedEpoch = generation;
      continue;
    }
    waitingForAudio.store(false);
    if (rebuildAudio) {
      // Disable resets the cursor, but can leave unsent PCM in DMA after stop.
      // Recreate only after cancellation so a later short task cannot leak that
      // old tail. Successful utterances finish with the normal silent drain.
      if (amplifier && i2s_del_channel(amplifier) != ESP_OK) {
        releasePart(part); failPipeline(generation, "I2S DMA 重置失败"); continue;
      }
      amplifier = nullptr;
      if (!initAudio()) { releasePart(part); failPipeline(generation, "I2S 重新初始化失败"); continue; }
      rebuildAudio = false;
    }
    if (!enabled || rate != part.rate) {
      if (enabled) i2s_channel_disable(amplifier);
      enabled = false;
      i2s_std_clk_config_t clock = I2S_STD_CLK_DEFAULT_CONFIG(part.rate);
      if (i2s_channel_reconfig_std_clock(amplifier, &clock) != ESP_OK) {
        releasePart(part); failPipeline(generation, "I2S 采样率配置失败"); continue;
      }
      rate = part.rate;
    }
    size_t cursor = 0, preloaded = 0;
    constexpr size_t preloadTarget = DMA_DESCRIPTORS * DMA_FRAMES * 2 * sizeof(int16_t);
    while (cursor < part.size && !cancelled(generation)) {
      const size_t monoBytes = min(part.size - cursor, size_t(2048));
      const int level = volume.load();
      uint32_t magnitude = 0;
      for (size_t i = 0; i < monoBytes / 2; ++i) {
        const int16_t sample = static_cast<int16_t>(le16(part.data + cursor + i * 2));
        stereo[i * 2] = stereo[i * 2 + 1] = static_cast<int32_t>(sample) * level / 100;
        const int32_t scaled = stereo[i * 2];
        magnitude += scaled < 0 ? -scaled : scaled;
      }
      // The already-scaled PCM drives visuals: one integer accumulation in the
      // existing conversion loop, no FFT, audio copy, heap allocation or socket.
      const uint8_t blockLevel = min(uint32_t(255), (magnitude / (monoBytes / 2)) * 255 / 4096);
      const size_t total = monoBytes * 2; size_t offset = 0;
      if (!enabled) {
        // Put valid samples into DMA before starting its clock. Enabling an
        // empty ring first otherwise transmits silence before the first write.
        if (i2s_channel_preload_data(amplifier, stereo, total, &offset) != ESP_OK || !offset) {
          failPipeline(generation, "I2S 首包预装失败"); break;
        }
        preloaded += offset;
        // Reuse this small conversion buffer to fill one complete DMA ring
        // before enable. IDF would let write() fill the queued unused buffers
        // afterwards too, but doing it now avoids a scheduling window at start.
        // A short first segment starts immediately: never await a future part.
        if (offset == total && preloaded < preloadTarget && cursor + monoBytes < part.size) {
          cursor += monoBytes; continue;
        }
        if (cancelled(generation)) { rebuildAudio = true; break; }
        if (i2s_channel_enable(amplifier) != ESP_OK) { failPipeline(generation, "I2S 启动失败"); break; }
        enabled = true;
        audioLevel.store(blockLevel); audioLevelAt.store(millis());
        if (!firstSampleAt.load()) firstSampleAt.store(millis());
        wakeDisplay();
      }
      uint32_t lastWrite = millis();
      while (offset < total && !cancelled(generation)) {
        size_t written = 0;
        const auto error = i2s_channel_write(amplifier, reinterpret_cast<uint8_t*>(stereo) + offset, total - offset, &written, 100);
        offset += written;
        if (written) lastWrite = millis();
        if (written && !firstSampleAt.load()) firstSampleAt.store(millis());
        if (error != ESP_OK && error != ESP_ERR_TIMEOUT) { failPipeline(generation, "I2S 播放失败"); break; }
        if (!written && millis() - lastWrite > 2000) { failPipeline(generation, "I2S 写入长时间无进展"); break; }
      }
      if (!cancelled(generation)) { audioLevel.store(blockLevel); audioLevelAt.store(millis()); }
      cursor += monoBytes;
    }
    if (!cancelled(generation)) playedParts.store(part.index);
    releasePart(part);
  }
}

bool pollTask() {
  JsonDocument response;
  if (!requestJson(devicePath("next?wait_ms=1500"), response)) return false;
  if (response["task"].isNull()) return false;
  auto task = response["task"];
  PlayJob job{};
  strlcpy(job.id, task["id"] | "", sizeof(job.id)); strlcpy(job.lease, task["lease"] | "", sizeof(job.lease));
  strlcpy(job.manifest, task["manifest_url"] | "", sizeof(job.manifest)); strlcpy(job.text, task["text"] | "", sizeof(job.text));
  if (!job.id[0] || !job.lease[0] || strncmp(job.manifest, "/api/device/", 12)) return false;
  active = job;
  if (lastFinishedId == job.id) { heartbeat("completed"); active = {}; return false; }
  portENTER_CRITICAL(&firstDownloadMux);
  epoch.fetch_add(1); firstDownloadElapsedMs.store(UINT32_MAX);
  portEXIT_CRITICAL(&firstDownloadMux);
  acceptedAt = millis(); firstSampleAt.store(0); playedParts.store(0);
  jobOledFrames = oledFrameCount.load(); jobOledBytes = oledPayloadBytes.load(); oledMaxFlushUs.store(0);
  audioLevel.store(0); audioLevelAt.store(0);
  pipelineFailed.store(false); pipelineError[0] = 0; waitingForAudio.store(true);
  cancelPlayback.store(false); volume.store(constrain(task["volume"] | 70, 0, 100));
  // Claiming already establishes the lease. Start fetching audio immediately;
  // the OLED worker and first periodic heartbeat run independently afterwards.
  requestedDisplay.theme = parseTheme(task["display_mode"] | "buddy");
  const char* status = task["status"] | "synthesizing";
  setScenePhase(!strcmp(status, "queued") ? OledScene::Phase::Queued :
                !strcmp(status, "completed") ? OledScene::Phase::Buffering : OledScene::Phase::Thinking);
  audioBusy.store(true); show(job.text, "Generating");
  return true;
}

bool fetchManifest(uint32_t& queuedThrough, bool& endQueued) {
  if (!active.id[0] || cancelPlayback.load() || endQueued || uxQueueSpacesAvailable(downloadQueue) == 0) return false;
  JsonDocument response;
  const String path = String(active.manifest) + "?lease=" + active.lease + "&after=" + queuedThrough + "&wait_ms=100";
  if (!requestJson(path, response)) {
    if (leaseLost) { leaseLost = false; cancelPlayback.store(true); }
    return false;
  }
  volume.store(constrain(response["volume"] | 70, 0, 100));
  if (!firstSampleAt.load()) {
    const char* status = response["status"] | "synthesizing";
    setScenePhase(!strcmp(status, "queued") ? OledScene::Phase::Queued :
                  !strcmp(status, "completed") ? OledScene::Phase::Buffering : OledScene::Phase::Thinking);
  }
  if ((response["cancel"] | false) || !response["error"].isNull()) {
    if (!response["error"].isNull()) failPipeline(epoch.load(), response["error"] | "语音生成失败");
    else cancelPlayback.store(true);
    return false;
  }
  for (auto entry : response["parts"].as<JsonArray>()) {
    const uint32_t index = entry["index"] | 0;
    if (index <= queuedThrough) continue;
    if (index != queuedThrough + 1) { failPipeline(epoch.load(), "音频片段序号不连续"); return false; }
    DownloadPart part{}; part.epoch = epoch.load(); part.index = index;
    strlcpy(part.path, entry["audio_url"] | "", sizeof(part.path));
    if (strncmp(part.path, "/api/audio/", 11)) { failPipeline(part.epoch, "音频地址无效"); return false; }
    if (xQueueSend(downloadQueue, &part, 0) != pdTRUE) break;
    queuedThrough = index;
  }
  if ((response["finished"] | false) && queuedThrough >= (response["available_parts"] | 0U)) {
    DownloadPart end{}; end.epoch = epoch.load(); end.index = queuedThrough; end.end = true;
    endQueued = xQueueSend(downloadQueue, &end, 0) == pdTRUE;
  }
  return true;
}
}

void setup() {
  Serial.begin(115200);
  initOled();
  if (!initAudio()) { Serial.println("I2S initialization failed"); show("音频初始化失败\n请检查功放引脚配置", "I2S error"); while (true) delay(1000); }
  downloadQueue = xQueueCreate(10, sizeof(DownloadPart)); audioQueue = xQueueCreate(4, sizeof(AudioPart));
  resultQueue = xQueueCreate(2, sizeof(PlayResult));
  if (!downloadQueue || !audioQueue || !resultQueue) { Serial.println("Queue allocation failed"); while (true) delay(1000); }
  if (displayReady) {
    displayQueue = xQueueCreate(1, sizeof(DisplayState));
    if (!displayQueue || xTaskCreatePinnedToCore(displayTask, "oled", 6144, nullptr, 1, &displayWorker, 0) != pdPASS) {
      Serial.println("OLED worker allocation failed"); while (true) delay(1000);
    }
  }
  xTaskCreatePinnedToCore(downloadTask, "prefetch", 12288, nullptr, 1, nullptr, 0);
  xTaskCreatePinnedToCore(playbackTask, "audio", 8192, nullptr, 2, nullptr, 1);
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Flash=%lu PSRAM=%lu; server=%s; device=%s\n", static_cast<unsigned long>(ESP.getFlashChipSize()), static_cast<unsigned long>(ESP.getPsramSize()), baseUrl().c_str(), DEVICE_ID);
}

void loop() {
  static uint32_t networkAt = 0, heartbeatAt = 0, reconnectAt = 0, queuedThrough = 0;
  static bool wasConnected = false, finishPending = false, endQueued = false, firstReported = false;
  static PlayResult finish{};
  if (xQueueReceive(resultQueue, &finish, 0) == pdTRUE) {
    finishPending = true; audioBusy.store(false);
    audioLevel.store(0);
    setScenePhase(finish.cancelled ? OledScene::Phase::Stopped : finish.ok ? OledScene::Phase::Finished : OledScene::Phase::Error);
    showHeading(finish.cancelled ? "Stopped" : finish.ok ? "Finished" : "Audio error");
    Serial.printf("[OLED] frames=%lu payload_bytes=%lu max_flush_us=%lu (audio finished)\n",
      static_cast<unsigned long>(oledFrameCount.load() - jobOledFrames),
      static_cast<unsigned long>(oledPayloadBytes.load() - jobOledBytes),
      static_cast<unsigned long>(oledMaxFlushUs.load()));
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (wasConnected) { wasConnected = false; if (!audioBusy.load()) setScenePhase(OledScene::Phase::Error); showHeading("WiFi reconnecting"); }
    if (millis() - reconnectAt > 10000) { reconnectAt = millis(); WiFi.reconnect(); }
    delay(2); return;
  }
  if (!wasConnected) {
    wasConnected = true; Serial.printf("WiFi connected: %s\n", WiFi.localIP().toString().c_str());
    if (!active.id[0]) { setScenePhase(OledScene::Phase::Idle); show((String("等待语音任务\nIP: ") + WiFi.localIP().toString()).c_str(), "Ready"); }
  }
  if (finishPending) {
    if (millis() - heartbeatAt > 300) {
      heartbeatAt = millis();
      if (heartbeat(finish.ok || finish.cancelled ? "completed" : "error", finish.error)) {
        lastFinishedId = active.id; active = {}; finishPending = false;
      }
    }
  } else if (audioBusy.load()) {
    // Queue ready PCM before a control round trip, including the first loop
    // after claiming a task. Audio playback itself never waits for heartbeat.
    if (millis() - networkAt > 25) { networkAt = millis(); fetchManifest(queuedThrough, endQueued); }
    const bool firstReady = firstSampleAt.load() != 0;
    if ((!firstReported && firstReady) || millis() - heartbeatAt > 500) {
      heartbeatAt = millis();
      const char* state = !firstReady ? "waiting" : waitingForAudio.load() ? "buffering" : "playing";
      if (heartbeat(state)) firstReported = firstReady;
      const char* heading = !firstReady ? "Generating" : waitingForAudio.load() ? "Buffering" : "Playing";
      showHeading(heading);
    }
  } else if (millis() - networkAt > 25) {
    networkAt = millis();
    if (pollTask()) {
      queuedThrough = 0; endQueued = false; firstReported = false;
      heartbeatAt = millis(); networkAt = millis();
      fetchManifest(queuedThrough, endQueued);
    }
  }
  delay(2);
}
