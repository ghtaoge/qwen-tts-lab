"""Create local LAN/client/device config without overwriting Wi-Fi credentials."""
import argparse
import json
import secrets
import socket
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.connect(('8.8.8.8', 80))
            return client.getsockname()[0]
    except OSError:
        return '192.168.1.100'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default=local_ip())
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    path = ROOT / 'server.local.json'
    if not path.exists():
        path.write_text(json.dumps({'client_token':secrets.token_hex(24), 'device_id':'esp32_01',
                                    'device_token':secrets.token_hex(24)}, indent=2), encoding='utf-8')
    settings = json.loads(path.read_text(encoding='utf-8'))
    client = ROOT / 'miniprogram' / 'config.local.js'
    if not client.exists():
        client.write_text('module.exports = '+json.dumps({'baseUrl':f'http://{args.host}:{args.port}',
                           'clientToken':settings['client_token'], 'deviceId':settings['device_id']}, ensure_ascii=False, indent=2)+';\n', encoding='utf-8')
    device = ROOT / 'firmware' / 'include' / 'secrets.h'
    if not device.exists():
        template = (device.parent / 'secrets.example.h').read_text(encoding='utf-8')
        template = template.replace('192.168.1.100', args.host).replace('COPY_FROM_SERVER_LOCAL_JSON', settings['device_token'])
        template = template.replace('SERVER_PORT = 8766', f'SERVER_PORT = {args.port}')
        device.write_text(template, encoding='utf-8')
    print(f'LAN URL: http://{args.host}:{args.port}')
    print('Local config files prepared; existing files and Wi-Fi credentials were preserved.')
    print('Fill firmware/include/secrets.h Wi-Fi values; use start-lan.cmd for phone/device access.')

if __name__ == '__main__': main()
