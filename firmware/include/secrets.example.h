#pragma once
// Run tools/bootstrap.py to create secrets.h, then fill in Wi-Fi credentials.
// Firmware uses protocol 2 (incremental manifest/audio parts); update backend and firmware together.
constexpr char WIFI_SSID[] = "YOUR_2.4G_WIFI";
constexpr char WIFI_PASSWORD[] = "YOUR_WIFI_PASSWORD";
constexpr char SERVER_HOST[] = "192.168.1.100";
constexpr uint16_t SERVER_PORT = 8766;
constexpr char DEVICE_ID[] = "esp32_01";
constexpr char DEVICE_TOKEN[] = "COPY_FROM_SERVER_LOCAL_JSON";
constexpr int OLED_SDA = 8, OLED_SCL = 9;
// Suggested free GPIOs; verify against your actual amplifier wiring.
constexpr int AMP_BCLK = 15, AMP_LRC = 16, AMP_DIN = 17;
// Existing local OLED project uses SSD1306. Set true for a SH1106 screen.
constexpr bool OLED_IS_SH1106 = false;
