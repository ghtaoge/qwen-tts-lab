#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <Wire.h>
#include <atomic>
#include "esp_heap_caps.h"
#include "driver/i2s_std.h"
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
struct DisplayState { char text[1300]; char heading[40]; };
PlayJob active{};
DisplayState requestedDisplay{}; // Only the Arduino loop writes this snapshot.
String lastFinishedId;

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
  const size_t size = strlen(displayText);
  size_t index = start;
  int x = 0, line = 0;
  oled->setFont(u8g2_font_wqy12_t_gb2312);
  while (index < size) {
    const size_t before = index;
    uint32_t cp;
    if (!decodeUtf8(displayText, size, index, cp)) break;
    if (cp == '\r') continue;
    if (cp == '\n') { x = 0; if (++line == 3) return index; continue; }
    const uint16_t glyph = cp <= 0xFFFF && u8g2_IsGlyph(oled->getU8g2(), cp) ? cp : '?';
    int width = u8g2_GetGlyphWidth(oled->getU8g2(), glyph);
    if (width <= 0) width = 6;
    if (x + width > 128) { x = 0; if (++line == 3) return before; }
    if (draw) oled->drawGlyph(x, 29 + 16 * line, glyph);
    x += width;
  }
  return index;
}

void render() {
  if (!displayReady) return;
  oled->clearBuffer();
  oled->setFont(u8g2_font_5x8_tf);
  oled->drawStr(0, 8, headerText);
  char counter[20]; snprintf(counter, sizeof(counter), "%u/%u", page + 1, pageCount);
  oled->drawStr(128 - oled->getStrWidth(counter), 8, counter);
  oled->drawHLine(0, 12, 128);
  layout(pageStart[page], true);
  oled->sendBuffer();
}

void applyDisplay(const DisplayState& state) {
  strlcpy(headerText, state.heading, sizeof(headerText));
  if (!strcmp(displayText, state.text)) { render(); return; }
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
  pageAt = millis(); render();
}

void queueDisplay() {
  // The full framebuffer takes about 100ms at 100kHz. A separate worker keeps
  // this I2C transfer off the manifest/download path, including the first task.
  if (displayQueue) xQueueOverwrite(displayQueue, &requestedDisplay);
  else applyDisplay(requestedDisplay); // Startup, before worker creation.
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
  for (;;) {
    if (xQueueReceive(displayQueue, &state, pdMS_TO_TICKS(100)) == pdTRUE) applyDisplay(state);
    if (pageCount > 1 && millis() - pageAt > 3000) {
      page = (page + 1) % pageCount; pageAt = millis(); render();
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

bool readExact(WiFiClient& stream, uint8_t* target, size_t length, uint32_t generation) {
  size_t offset = 0; uint32_t lastData = millis();
  while (offset < length && !cancelled(generation)) {
    const int available = stream.available();
    if (available > 0) {
      const int count = stream.read(target + offset, min(length - offset, static_cast<size_t>(available)));
      if (count > 0) { offset += count; lastData = millis(); }
    } else if (!stream.connected() || millis() - lastData > 8000) return false;
    else vTaskDelay(pdMS_TO_TICKS(1));
  }
  return offset == length;
}
uint16_t le16(const uint8_t* p) { return p[0] | (uint16_t(p[1]) << 8); }
uint32_t le32(const uint8_t* p) { return p[0] | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }
bool skipBytes(WiFiClient& stream, uint32_t size, uint32_t generation) {
  uint8_t discard[256];
  while (size) { const size_t count = min(size, uint32_t(sizeof(discard))); if (!readExact(stream, discard, count, generation)) return false; size -= count; }
  return true;
}

bool wavHeader(WiFiClient& stream, uint32_t& rate, uint32_t& bytes, uint32_t generation) {
  uint8_t header[16];
  if (!readExact(stream, header, 12, generation) || memcmp(header, "RIFF", 4) || memcmp(header + 8, "WAVE", 4)) return false;
  bool formatSeen = false;
  for (int chunks = 0; chunks < 30; ++chunks) {
    if (!readExact(stream, header, 8, generation)) return false;
    const uint32_t size = le32(header + 4);
    if (!memcmp(header, "fmt ", 4)) {
      if (size < 16 || size > 4096 || !readExact(stream, header, 16, generation)) return false;
      rate = le32(header + 4);
      if (le16(header) != 1 || le16(header + 2) != 1 || le16(header + 14) != 16 || le16(header + 12) != 2 || rate < 8000 || rate > 48000) return false;
      formatSeen = true;
      if (!skipBytes(stream, size - 16 + (size & 1), generation)) return false;
    } else if (!memcmp(header, "data", 4)) {
      // Buffer one bounded segment, never the entire long utterance.
      if (!formatSeen || size == 0 || size > 4 * 1024 * 1024 || (size & 1)) return false;
      bytes = size; return true;
    } else {
      if (size > 65536 || !skipBytes(stream, size + (size & 1), generation)) return false;
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
}

void downloadTask(void*) {
  DownloadPart request;
  WiFiClient client; HTTPClient http;
  http.setReuse(true); http.setTimeout(8000); http.setConnectTimeout(3000);
  for (;;) {
    if (xQueueReceive(downloadQueue, &request, portMAX_DELAY) != pdTRUE) continue;
    if (cancelled(request.epoch)) continue;
    AudioPart part{}; part.epoch = request.epoch; part.index = request.index; part.end = request.end;
    if (!request.end) {
      const uint32_t downloadStarted = millis();
      bool ok = http.begin(client, baseUrl() + request.path);
      if (ok) { http.addHeader("X-Device-Token", DEVICE_TOKEN); ok = http.GET() == 200; }
      uint32_t bytes = 0;
      if (ok) ok = wavHeader(*http.getStreamPtr(), part.rate, bytes, request.epoch);
      if (ok) {
        // Backpressure keeps prefetched PCM bounded. N16R8 uses its PSRAM here.
        const size_t budget = 2 * 1024 * 1024;
        while (!cancelled(request.epoch) && bufferedBytes.load() > (bytes > budget ? 0 : budget - bytes)) vTaskDelay(pdMS_TO_TICKS(5));
        if (!cancelled(request.epoch)) {
          part.size = bytes;
          part.data = static_cast<uint8_t*>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
          if (!part.data && bytes <= 65536) part.data = static_cast<uint8_t*>(malloc(bytes));
          if (part.data) { bufferedBytes.fetch_add(bytes); ok = readExact(*http.getStreamPtr(), part.data, bytes, request.epoch); }
          else ok = false;
        } else ok = false;
      }
      const uint32_t downloadElapsed = millis() - downloadStarted;
      // A cancellation can stop inside the HTTP body. Close that socket rather
      // than letting its remaining PCM corrupt the next task's HTTP response.
      if (!ok) http.setReuse(false);
      http.end();
      http.setReuse(true);
      if (!ok) {
        releasePart(part);
        if (!cancelled(request.epoch)) failPipeline(request.epoch, "音频片段下载、WAV 格式或内存分配失败");
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
    }
    if (audioBusy.load() && cancelPlayback.load() && finishedEpoch != generation) {
      if (enabled) i2s_channel_disable(amplifier);
      enabled = false; rebuildAudio = true;
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
      for (size_t i = 0; i < monoBytes / 2; ++i) {
        const int16_t sample = static_cast<int16_t>(le16(part.data + cursor + i * 2));
        stereo[i * 2] = stereo[i * 2 + 1] = static_cast<int32_t>(sample) * level / 100;
      }
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
        if (!firstSampleAt.load()) firstSampleAt.store(millis());
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
  pipelineFailed.store(false); pipelineError[0] = 0; waitingForAudio.store(true);
  cancelPlayback.store(false); volume.store(constrain(task["volume"] | 70, 0, 100));
  // Claiming already establishes the lease. Start fetching audio immediately;
  // the OLED worker and first periodic heartbeat run independently afterwards.
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
    if (!displayQueue || xTaskCreatePinnedToCore(displayTask, "oled", 6144, nullptr, 1, nullptr, 0) != pdPASS) {
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
    showHeading(finish.cancelled ? "Stopped" : finish.ok ? "Finished" : "Audio error");
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (wasConnected) { wasConnected = false; showHeading("WiFi reconnecting"); }
    if (millis() - reconnectAt > 10000) { reconnectAt = millis(); WiFi.reconnect(); }
    delay(2); return;
  }
  if (!wasConnected) {
    wasConnected = true; Serial.printf("WiFi connected: %s\n", WiFi.localIP().toString().c_str());
    if (!active.id[0]) show((String("等待语音任务\nIP: ") + WiFi.localIP().toString()).c_str(), "Ready");
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
