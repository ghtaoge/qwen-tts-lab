#pragma once

#include <stdint.h>
#include <U8g2lib.h>

// Stateless integer drawing only. The caller owns clearing, fonts, Chinese
// pagination, frame pacing and display transfer; audio never waits here.
namespace OledScene {

enum class Theme : uint8_t { Buddy, Wave, Text };
enum class Phase : uint8_t { Idle, Queued, Thinking, Buffering, Playing, Finished, Stopped, Error };

struct Frame {
  Theme theme;
  Phase phase;
  uint8_t level;
  uint32_t now_ms;
  uint32_t phase_since_ms;
};

struct TextBox {
  uint8_t x, y, width, height, rows, line_height;
};

inline TextBox textBox(Theme theme) {
  return theme == Theme::Text ? TextBox{0, 16, 128, 48, 3, 16} : TextBox{46, 16, 82, 48, 3, 16};
}

namespace detail {

inline void dots(U8G2& screen, uint32_t now) {
  const uint8_t active = static_cast<uint8_t>((now / 250U) % 3U);
  for (uint8_t index = 0; index < 3; ++index) {
    const uint8_t size = index == active ? 2 : 1;
    screen.drawBox(15 + index * 6, 18, size, size);
  }
}

inline void sparkle(U8G2& screen, uint8_t x, uint8_t y) {
  screen.drawPixel(x, y - 2);
  screen.drawPixel(x, y + 2);
  screen.drawPixel(x - 2, y);
  screen.drawPixel(x + 2, y);
  screen.drawPixel(x, y);
}

inline void heart(U8G2& screen) {
  screen.drawHLine(18, 17, 3); screen.drawHLine(23, 17, 3);
  screen.drawHLine(17, 18, 10); screen.drawHLine(18, 19, 8);
  screen.drawHLine(19, 20, 6); screen.drawHLine(20, 21, 4);
  screen.drawHLine(21, 22, 2);
}

inline void hourglass(U8G2& screen, uint8_t x, uint8_t y) {
  screen.drawHLine(x, y, 7); screen.drawHLine(x, y + 8, 7);
  screen.drawLine(x, y + 1, x + 6, y + 7);
  screen.drawLine(x + 6, y + 1, x, y + 7);
}

inline void buddy(U8G2& screen, const Frame& frame) {
  const bool celebrate = frame.phase == Phase::Finished &&
      static_cast<uint32_t>(frame.now_ms - frame.phase_since_ms) < 1200U;
  const bool blink = frame.phase == Phase::Idle && (frame.now_ms % 4200U) < 250U;
  const bool resting = frame.phase == Phase::Stopped || frame.phase == Phase::Finished;
  screen.drawFrame(7, 25, 29, 25);
  screen.drawHLine(7, 22, 6); screen.drawBox(10, 20, 3, 2);
  screen.drawHLine(30, 22, 6); screen.drawBox(30, 20, 3, 2);

  if (frame.phase == Phase::Error) {
    // Uneven brows and one raised eye: puzzled, rather than a flashing alert.
    screen.drawLine(11, 30, 16, 32); screen.drawHLine(26, 30, 6);
    screen.drawBox(13, 34, 3, 3); screen.drawBox(28, 33, 2, 4);
  } else if (blink || resting) {
    screen.drawHLine(12, 34, 5); screen.drawHLine(26, 34, 5);
    if (celebrate) {
      screen.drawPixel(12, 33); screen.drawPixel(16, 33);
      screen.drawPixel(26, 33); screen.drawPixel(30, 33);
    }
  } else {
    screen.drawBox(13, 32, 3, 4); screen.drawBox(27, 32, 3, 4);
  }

  if (frame.phase == Phase::Playing && frame.level != 0) {
    const uint8_t opening = 2U + static_cast<uint16_t>(frame.level) * 5U / 255U;
    screen.drawFrame(18, 41, 8, opening);
  } else if (frame.phase == Phase::Error) {
    screen.drawHLine(19, 43, 6); screen.drawPixel(18, 44); screen.drawPixel(25, 44);
  } else {
    screen.drawHLine(19, 43, 6);
    if (celebrate) { screen.drawPixel(18, 42); screen.drawPixel(25, 42); }
  }

  screen.drawHLine(13, 51, 18);
  screen.drawVLine(14, 52, 8); screen.drawVLine(29, 52, 8);
  screen.drawHLine(14, 59, 16);
  screen.drawHLine(9, 61, 9); screen.drawHLine(26, 61, 9);
  const uint8_t lift = celebrate ? 5 : frame.phase == Phase::Playing ? frame.level / 64U : 0;
  screen.drawHLine(7, 53 - lift, 7); screen.drawHLine(30, 53 - lift, 7);

  switch (frame.phase) {
    case Phase::Queued:
    case Phase::Thinking: dots(screen, frame.now_ms); break;
    case Phase::Buffering: hourglass(screen, 19, 16); break;
    case Phase::Finished: if (celebrate) heart(screen); break;
    case Phase::Error:
      screen.drawVLine(21, 17, 3); screen.drawPixel(21, 22); break;
    default: break;
  }
}

inline void wave(U8G2& screen, const Frame& frame) {
  screen.drawHLine(4, 54, 35);
  if (frame.phase == Phase::Playing) {
    for (uint8_t index = 0; index < 8; ++index) {
      const uint8_t step = static_cast<uint8_t>((frame.now_ms / 125U + index * 3U) & 15U);
      const uint8_t shape = step < 8 ? step : 15 - step;
      const uint8_t height = static_cast<uint32_t>(frame.level) * (shape + 2U) * 28U / (255U * 9U);
      if (height != 0) screen.drawBox(5 + index * 4, 52 - height, 2, height);
    }
    // A small speaker glyph stays static when muted. All bar heights are zero.
    screen.drawBox(15, 59, 3, 3); screen.drawLine(18, 59, 21, 57);
    screen.drawVLine(21, 57, 7); screen.drawLine(18, 61, 21, 63);
  } else if (frame.phase == Phase::Queued || frame.phase == Phase::Thinking) {
    dots(screen, frame.now_ms); hourglass(screen, 18, 34);
  } else if (frame.phase == Phase::Buffering) {
    hourglass(screen, 18, 34);
  } else if (frame.phase == Phase::Error) {
    screen.drawVLine(21, 30, 10); screen.drawBox(21, 43, 1, 2);
    screen.drawFrame(11, 27, 21, 22);
  } else if (frame.phase == Phase::Finished) {
    if (static_cast<uint32_t>(frame.now_ms - frame.phase_since_ms) < 1200U) {
      screen.drawLine(14, 39, 19, 44); screen.drawLine(19, 44, 29, 32);
      sparkle(screen, 9, 28); sparkle(screen, 34, 26);
    } else { screen.drawHLine(14, 40, 15); }
  } else if (frame.phase == Phase::Stopped) {
    screen.drawBox(16, 34, 3, 12); screen.drawBox(24, 34, 3, 12);
  } else {
    // A quiet radio waiting for its next message.
    screen.drawFrame(10, 31, 25, 16); screen.drawFrame(13, 34, 12, 9);
    screen.drawBox(29, 35, 2, 2); screen.drawBox(29, 40, 2, 2);
    screen.drawLine(14, 30, 23, 23);
  }
}

}  // namespace detail

inline void draw(U8G2& screen, const Frame& frame) {
  if (frame.theme == Theme::Text) return;
  screen.drawVLine(43, 16, 48);
  if (frame.theme == Theme::Wave) detail::wave(screen, frame);
  else detail::buddy(screen, frame);
}

}  // namespace OledScene
