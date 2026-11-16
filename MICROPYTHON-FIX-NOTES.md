# ESP32 MicroPython record decode fix

Fixed `zklib/helpers.py`: `.decode('ascii', errors='ignore')` caused
`TypeError: function doesn't take keyword arguments` on MicroPython.
The replacement extracts the zero-terminated 9-byte ZKT user ID using
ASCII byte filtering without decode keyword arguments.

`main.py` now prints the traceback when a synchronization cycle fails.

## Deploy with Thonny
1. Stop `main.py` (Ctrl+C).
2. Upload `zklib/helpers.py` to `/zklib/helpers.py` on the MicroPython device.
3. Optionally upload the updated `main.py` to `/main.py` for traceback logging.
4. Keep your existing customized `/config.py` (do not overwrite it).
5. Press Ctrl+D to restart.

Your backend cursor currently starts at record 10; that is fine. The
fix allows records on the next page to be decoded. Advance the cursor
only when your backend responds with a matching successful acknowledgment.
