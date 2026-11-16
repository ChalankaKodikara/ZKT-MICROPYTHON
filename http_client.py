"""Minimal HTTP/HTTPS JSON requests for CPython and MicroPython.

Responses must have Content-Length (Express sets this automatically).
Use a public HTTPS endpoint in production; certificate verification on
MicroPython varies by firmware. See README.
"""
import json
import socket
try:
    import ssl
except ImportError:
    import ussl as ssl

class HTTPError(Exception):
    def __init__(self, status, body):
        super().__init__('HTTP %s: %s' % (status, str(body)[:200]))
        self.status = status
        self.body = body


def _endpoint(url):
    # Parse a simple absolute HTTP URL without urllib (not present on MicroPython).
    if url.startswith('https://'):
        tls = True
        tail = url[8:]
        default = 443
    elif url.startswith('http://'):
        tls = False
        tail = url[7:]
        default = 80
    else:
        raise ValueError('Backend URL must start with http:// or https://')
    host_port, slash, route = tail.partition('/')
    if not host_port or '@' in host_port:
        raise ValueError('Invalid backend address')
    host, sep, port_text = host_port.partition(':')
    port = int(port_text) if sep else default
    return tls, host, port, '/' + route if slash else '/'


def _read_exact(f, n):
    chunks = []
    while n:
        piece = f.read(n)
        if not piece:
            raise OSError('HTTP response ended early')
        chunks.append(piece)
        n -= len(piece)
    return b''.join(chunks)


def request_json(method, base_url, path, token, data=None, timeout=25):
    tls, host, port, base_path = _endpoint(base_url.rstrip('/') + path)
    body = json.dumps(data).encode() if data is not None else b''
    if len(body) > 12000:
        raise ValueError('Page too large for constrained HTTP client')
    addr = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0][-1]
    s = socket.socket()
    f = None
    try:
        s.settimeout(timeout)
        s.connect(addr)
        if tls:
            # On CPython use a verifying TLS context. MicroPython SSL support
            # varies and may not verify the server certificate by default.
            if hasattr(ssl, 'create_default_context'):
                s = ssl.create_default_context().wrap_socket(s, server_hostname=host)
            else:
                s = ssl.wrap_socket(s, server_hostname=host)
        req = ('%s %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n'
               'Accept: application/json\r\nContent-Type: application/json\r\n'
               'Connection: close\r\nContent-Length: %d\r\n\r\n' %
               (method, base_path, host, token, len(body))).encode()
        s.sendall(req)
        if body:
            s.sendall(body)
        f = s.makefile('rb')
        status_line = f.readline()
        parts = status_line.split(None, 2)
        if len(parts) < 2:
            raise OSError('Invalid HTTP status: %r' % status_line)
        status = int(parts[1])
        headers = {}
        while True:
            line = f.readline()
            if line in (b'\r\n', b'\n', b''):
                break
            key, sep, value = line.partition(b':')
            if sep:
                headers[key.strip().lower()] = value.strip()
        if b'transfer-encoding' in headers and b'chunked' in headers[b'transfer-encoding'].lower():
            raise OSError('Backend must return Content-Length, not chunked encoding')
        if b'content-length' not in headers:
            raise OSError('Backend response missing Content-Length')
        length = int(headers[b'content-length'])
        if length < 0 or length > 12000:
            raise OSError('Unexpected HTTP response size: %s' % length)
        raw = _read_exact(f, length)
        result = json.loads(raw.decode()) if raw else {}
        if status < 200 or status >= 300:
            raise HTTPError(status, result)
        return status, result
    finally:
        if f:
            try:
                f.close()
            except Exception:
                pass
        try:
            s.close()
        except Exception:
            pass
