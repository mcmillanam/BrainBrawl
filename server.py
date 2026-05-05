# server.py – Simple Flask server to serve Brain Brawl frontend and handle POST requests

import os
from flask import Flask, request, send_from_directory, jsonify, abort

app = Flask(__name__, static_folder='public', static_url_path='')

# Serve the index.html for the root path
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

# Example POST endpoint for login/signup (placeholder implementation)
@app.route('/login', methods=['POST'])
def login():
    # In a real app you would validate credentials and interact with DynamoDB.
    data = request.form or request.json
    if not data:
        abort(400, 'No data provided')
    # Just echo back the received fields for now
    return jsonify({
        'status': 'ok',
        'received': data
    })

# Example POST endpoint for creating a quiz/trivia (placeholder)
@app.route('/create', methods=['POST'])
def create():
    # Expect multipart/form-data for file uploads; Flask handles it automatically.
    # This stub just returns the fields it got.
    data = request.form.to_dict()
    files = {k: v.filename for k, v in request.files.items()}
    return jsonify({
        'status': 'created',
        'data': data,
        'files': files
    })

# Run the app – bind to all interfaces (0.0.0.0) on port 80 (or $PORT)
if __name__ == '__main__':
    port = int(os.getenv('PORT', 80))
    # Use sudo when binding to privileged ports if needed.
    app.run(host='0.0.0.0', port=port)
