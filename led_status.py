"""Non-blocking status LED using an ESP32 hardware timer, 200 ms per slot.
Patterns: setup=slow blink, wifi=fast blink, sync=double pulse,
ready=solid, success=short flash, error=triple flash.
"""
try:
    from machine import Pin, Timer
except ImportError:
    Pin = Timer = None

PATTERNS = {
    'off': (0,),
    'setup': (1, 0, 0, 0, 0),
    'wifi': (1, 0),
    'ready': (1,),
    'sync': (1, 1, 0, 1, 0, 0, 0, 0),
    'success': (1, 1, 1, 0, 0),
    'error': (1, 0, 1, 0, 1, 0, 0, 0, 0, 0),
}

class StatusLED:
    def __init__(self, pin=2, active_high=True):
        self._pin = None
        self._timer = None
        self._active = 1 if active_high else 0
        self._pattern = PATTERNS['off']
        self._step = 0
        if Pin is None or pin is None or pin < 0:
            return
        self._pin = Pin(pin, Pin.OUT)
        self._write(0)
        try:
            self._timer = Timer(0)
            self._timer.init(period=200, mode=Timer.PERIODIC, callback=self._tick)
        except Exception as e:
            print('LED timer unavailable:', e)
            self._timer = None

    def _write(self, on):
        if self._pin is not None:
            self._pin.value(self._active if on else (1 - self._active))

    def _tick(self, _timer):
        pattern = self._pattern
        self._write(pattern[self._step])
        self._step += 1
        if self._step >= len(pattern):
            self._step = 0

    def set(self, name):
        self._pattern = PATTERNS.get(name, PATTERNS['error'])
        self._step = 0
        self._write(self._pattern[0])

    def close(self):
        if self._timer is not None:
            self._timer.deinit()
        self._write(0)
