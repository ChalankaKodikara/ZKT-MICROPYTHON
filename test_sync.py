"""Run: python test_sync.py (no ESP32 required)."""
import main
import settings_store
import wifi_portal
import tempfile
import os
import json

CFG = {
 'wifi_ssid': 'test-network', 'wifi_password': 'password123',
 'device_ip': '192.168.1.236', 'device_port': 4370,
 'device_id': 'zkt-001', 'backend_base_url': 'http://192.168.1.38:3000',
 'backend_api_key': 'some-key', 'page_limit': 5
}

class FakeLED:
    def set(self, _): pass

def test_retry_same_page():
    attempts = []
    page = {'count': 2, 'next_cursor': '2.' + 'a'*80,
            'records': [{'user_sn':1}, {'user_sn':2}]}
    old_request = main.request_json
    old_sleep = main.sleep_seconds
    def fake(method, base, path, token, data, timeout):
        attempts.append(json.dumps(data, sort_keys=True))
        if len(attempts) == 1:
            raise OSError('simulated lost HTTP acknowledgment')
        return 200, {'success':True, 'committed_cursor':data['next_cursor']}
    main.request_json = fake
    main.sleep_seconds = lambda _: None
    try:
        result = main.push_until_acked(CFG, page, None, FakeLED())
        assert result == page['next_cursor']
        assert attempts[0] == attempts[1]
    finally:
        main.request_json = old_request
        main.sleep_seconds = old_sleep

def test_conflict():
    old_request = main.request_json
    page = {'count':1, 'next_cursor':'1.' + 'b'*80,'records':[{'user_sn':1}]}
    def fake(*args, **kwargs):
        raise main.HTTPError(409, {'error':'CURSOR_MISMATCH'})
    main.request_json = fake
    try:
        assert main.push_until_acked(CFG, page, None, FakeLED()) is None
    finally:
        main.request_json = old_request

def test_settings_and_form():
    with tempfile.TemporaryDirectory() as folder:
        current = os.getcwd()
        os.chdir(folder)
        try:
            settings_store.save(dict(CFG))
            assert settings_store.load()['device_ip'] == '192.168.1.236'
            raw = (b'wifi_ssid=My+Network&device_ip=192.168.1.236&backend_base_url='
                   b'http%3A%2F%2F192.168.1.38%3A3000')
            v = wifi_portal._parse_form(raw)
            assert v['wifi_ssid'] == 'My Network'
            assert v['backend_base_url'] == 'http://192.168.1.38:3000'
            page = wifi_portal._page(CFG)
            assert 'ZKT Attendance Setup' in page
            assert 'some-key' not in page and 'password123' not in page
        finally:
            os.chdir(current)

if __name__ == '__main__':
    test_retry_same_page()
    test_conflict()
    test_settings_and_form()
    print('PASS: retry exact batch, 409 conflict, settings persistence, portal URL parsing')
