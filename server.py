import http.server
import socketserver
import socket
import os
import sys

# Define port
PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class DualStackHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve files from the directory of this script
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Enable CORS and Range requests support for local client requests
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        super().end_headers()

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # doesn't even have to be reachable
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

def print_qr_ascii(url):
    """
    Prints a very simple simulated ascii QR border to make local scanning easier
    without requiring external libraries.
    """
    print("\n" + "=" * 50)
    print("      AeroMedia - Local Media Server POC")
    print("=" * 50)
    print(f"Web App Root:      {DIRECTORY}")
    print(f"Local Access Link: http://localhost:{PORT}")
    print(f"LAN Access Link:   http://{get_local_ip()}:{PORT}")
    print("=" * 50)
    print("\nScan the QR code in the browser modal to connect other local tablets.")
    print("Press Ctrl+C to terminate the mock server.\n")

def run():
    # Make sure we serve from this script's directory
    os.chdir(DIRECTORY)
    
    local_ip = get_local_ip()
    url = f"http://{local_ip}:{PORT}"
    
    Handler = DualStackHTTPRequestHandler
    
    # Allow port reuse
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print_qr_ascii(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            sys.exit(0)

if __name__ == '__main__':
    run()
