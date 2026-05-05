# http_server.py – Simple Python HTTP server with POST support
# Uses the built‑in http.server module but adds a custom handler that can accept
# POST requests (e.g., for /login or /create) while still serving static files
# from the "public" directory.

import os
import urllib
import json
import boto3
from http.server import SimpleHTTPRequestHandler, HTTPServer

# Initialize DynamoDB resource (uses instance role permissions)
aws_region = os.getenv('AWS_REGION', 'us-east-1')
# boto3 will automatically pick up credentials from the EC2 instance role
dynamodb = boto3.resource('dynamodb', region_name=aws_region)

# Directory that holds the static frontend files
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")

class POSTHandler(SimpleHTTPRequestHandler):
    """Extend SimpleHTTPRequestHandler to handle POST requests and serve static files.

    - GET/HEAD are overridden to always serve files from the ``public`` directory.
    - POST reads the request body and processes known routes (currently ``/create``).
    """

    # ---------------------------------------------------------------------
    # Serve static files from the public folder for any GET request
    # ---------------------------------------------------------------------
    def do_GET(self):
        # Strip query parameters
        req_path = self.path.split('?', 1)[0]
        # -----------------------------------------------------------------
        # API endpoints (GET)
        # -----------------------------------------------------------------
        if req_path == '/quizzes':
            try:
                table = dynamodb.Table('Quizzes')
                resp = table.scan()
                items = resp.get('Items', [])
                response_body = json.dumps({'status': 'ok', 'quizzes': items}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response_body)))
                self.end_headers()
                self.wfile.write(response_body)
                return
            except Exception as e:
                err_body = json.dumps({'status': 'error', 'error': str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
                return
        # -----------------------------------------------------------------
        # Trivia endpoint
        # -----------------------------------------------------------------
        if req_path == '/trivia':
            try:
                table = dynamodb.Table('Trivia')
                resp = table.scan()
                items = resp.get('Items', [])
                response_body = json.dumps({'status': 'ok', 'trivia': items}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response_body)))
                self.end_headers()
                self.wfile.write(response_body)
                return
            except Exception as e:
                err_body = json.dumps({'status': 'error', 'error': str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
                return
        # -----------------------------------------------------------------
        # Serve the main page for root or /public/
        if req_path in ('/', '/public/', '/public'):
            # Serve index.html
            file_path = os.path.join(PUBLIC_DIR, 'index.html')
        else:
            # If the URL starts with /public/, strip that prefix so we map correctly
            if req_path.startswith('/public/'):
                # Remove the leading '/public' part but keep the slash before the file name
                req_path = req_path[len('/public'):]  # keep the leading '/'
            # Build absolute file path inside PUBLIC_DIR
            file_path = os.path.join(PUBLIC_DIR, req_path.lstrip('/'))
        # If a directory is requested, try to serve its index.html
        if os.path.isdir(file_path):
            file_path = os.path.join(file_path, 'index.html')
        # Verify the file exists
        if not os.path.isfile(file_path):
            # Fall back to generic index.html if present (SPA fallback)
            fallback_path = os.path.join(PUBLIC_DIR, 'index.html')
            if os.path.isfile(fallback_path):
                file_path = fallback_path
            else:
                self.send_error(404, "File not found")
                return
        # Determine MIME type
        mime_type = self.guess_type(file_path)
        try:
            with open(file_path, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', mime_type)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error(500, f"Error reading file: {e}")

    # ---------------------------------------------------------------------
    # Helper to translate URLs – not used now because we handle paths manually
    # ---------------------------------------------------------------------
    def translate_path(self, path):
        # Retain compatibility but not required for our custom GET handling.
        path = path.split('?', 1)[0]
        path = path.split('#', 1)[0]
        path = urllib.parse.unquote(path)
        return os.path.join(PUBLIC_DIR, path.lstrip('/'))

    # ---------------------------------------------------------------------
    # POST handling – unchanged except for route logic
    # ---------------------------------------------------------------------
    def do_POST(self):
        # Determine content length (for reading the request body)
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b''
        # Default response (echo) – will be overridden for known routes
        response_body = {
            "status": "ok",
            "path": self.path,
            "received": post_data.decode('utf-8', errors='replace')
        }
        status_code = 200

        # --- Route handling -------------------------------------------------
        if self.path == '/create':
            # Expect JSON payload for quiz/trivia creation
            try:
                import uuid, json
                # Ensure we actually received a body
                if not post_data:
                    raise ValueError('Empty request body')
                try:
                    payload = json.loads(post_data)
                except json.JSONDecodeError as jde:
                    raise ValueError(f'Invalid JSON: {jde}')
                # Required fields: type (quiz|trivia), title, content
                qtype = payload.get('type')
                title = payload.get('title')
                content = payload.get('content')
                questions = payload.get('questions', [])
                if qtype not in ('quiz', 'trivia') or not title or not content:
                    raise ValueError('Missing required fields')

                # Choose DynamoDB table and primary key based on type
                if qtype == 'quiz':
                    table_name = 'Quizzes'
                    pk_name = 'quizId'
                else:
                    table_name = 'Trivia'
                    pk_name = 'triviaId'
                table = dynamodb.Table(table_name)

                # Generate a unique identifier for the item
                item_id = str(uuid.uuid4())

                item = {
                    pk_name: item_id,
                    'type': qtype,
                    'title': title,
                    'content': content,
                    'questions': questions,
                }
                table.put_item(Item=item)
                response_body = {"status": "created", "table": table_name, "item": item}
            except Exception as e:
                status_code = 500
                response_body = {"status": "error", "error": str(e)}
        elif self.path == '/login':
            # Simple user signup/login endpoint – stores user in Users table
            try:
                payload = json.loads(post_data)
                username = payload.get('username')
                password = payload.get('password')
                if not username or not password:
                    raise ValueError('Missing username or password')
                users_table = dynamodb.Table('Users')
                users_table.put_item(Item={
                    'username': username,
                    'password': password,
                    'createdAt': int(os.getenv('EPOCH', '0'))
                })
                response_body = {"status": "logged_in", "user": username}
            except Exception as e:
                status_code = 500
                response_body = {"status": "error", "error": str(e)}
        # -------------------------------------------------------------------


def run(server_class=HTTPServer, handler_class=POSTHandler, port=80):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f"Python HTTP server with POST support listening on http://0.0.0.0:{port}")
    httpd.serve_forever()

if __name__ == '__main__':
    # Use the PORT environment variable if set (common in cloud deployments)
    port = int(os.getenv('PORT', 80))
    run(port=port)
