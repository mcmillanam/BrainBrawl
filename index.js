// brain-brawl - Express server with DynamoDB & S3 integration
// NOTE: This is a minimal scaffold focusing on the requested routes.
// For production use, add proper validation, error handling, authentication,
// and secure storage of AWS credentials (e.g., IAM roles, Secrets Manager).

require('dotenv').config();
const express = require('express');
const { randomBytes } = require('crypto');
const multer = require('multer');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const bcrypt = require('bcrypt');
const { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const app = express();

// Serve static frontend files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
const port = process.env.PORT || 3000;

// AWS SDK setup – region from .env or default
const awsRegion = process.env.AWS_REGION || 'us-east-1';
const ddbClient = new DynamoDBClient({ region: awsRegion });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: awsRegion });
const lambdaClient = new LambdaClient({ region: awsRegion });
const bucketName = 'brain-brawl-assets-mcmillanam'; // must exist in AWS account

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Simple in‑memory session store (token → userId)
const sessions = {};

// Middleware to attach authenticated userId to request (expects `Authorization: Bearer <token>`)
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    req.userId = sessions[token];
  }
  next();
});

// Multer config – store files in memory before uploading to S3
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ---------- Helper Functions ----------
const invokeLambda = async (functionName, payload) => {
  // Helper to invoke an AWS Lambda function via the SDK
  const cmd = new InvokeCommand({
    FunctionName: functionName,
    Payload: Buffer.from(JSON.stringify(payload)),
  });
  const response = await lambdaClient.send(cmd);
  let result = null;
  if (response.Payload) {
    try { result = JSON.parse(Buffer.from(response.Payload).toString()); } catch (_) {}
  }
  return { statusCode: response.StatusCode, result };
};

// NOTE: The following incorrect fetchAll helper (which attempted to invoke a Lambda) has been removed.
// The correct fetchAll function for DynamoDB scans is defined below.

async function fetchAll(table) {
  const cmd = new ScanCommand({ TableName: table });
  const result = await ddb.send(cmd);
  return result.Items || [];
}

// ---------- Routes ----------
// 1. Landing page
const baseStyle = `<style>
  body{background:#121212;color:#fff;font-family:Arial,Helvetica,sans-serif;margin:0;padding:20px;}
  a{color:#4ea5ff;text-decoration:none;}
  nav a{margin-right:15px;}
  h1,h2{color:#fff;}
  input, textarea, select{background:#222;color:#fff;border:1px solid #444;padding:5px;margin:5px 0;width:100%;max-width:400px;}
  button{background:#4ea5ff;color:#fff;border:none;padding:8px 12px;margin-top:10px;cursor:pointer;}
  button:hover{background:#3b8ad9;}
</style>`;

app.get('/', (req, res) => {
  // Serve the static index.html from the public folder
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. /quizzes – list quizzes from DynamoDB table "quizzes"
app.get('/quizzes', async (req, res) => {
  try {
    const items = await fetchAll('Quizzes');
    const list = items.map((q, i) => `<li>${q.title || 'Untitled'} – ${q.description || ''}</li>`).join('');
    const html = `
      <h2>Quizzes</h2>
      <ul>${list}</ul>
      <a href="/">← Back to Home</a>
    `;
    res.send(baseStyle + html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error reading quizzes');
  }
});

// 3. /trivia – list trivia from DynamoDB table "trivia"
app.get('/trivia', async (req, res) => {
  try {
    const items = await fetchAll('Trivia');
    const list = items.map((t, i) => `<li>${t.question || 'No question'} – ${t.category || ''}</li>`).join('');
    const html = `
      <h2>Trivia</h2>
      <ul>${list}</ul>
      <a href="/">← Back to Home</a>
    `;
    res.send(baseStyle + html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error reading trivia');
  }
});

// 4. /login – very simple sign‑up / login form (no real auth)
app.get('/login', (req, res) => {
  const html = `
    <h2>Login / Sign‑up</h2>
    <form method="POST" action="/login">
      <label>Email: <input type="email" name="email" required></label><br>
      <label>Password: <input type="password" name="password" required></label><br>
      <button type="submit" name="action" value="login">Login</button>
      <button type="submit" name="action" value="signup">Sign‑up</button>
    </form>
    <a href="/">← Back to Home</a>
  `;
  res.send(baseStyle + html);
});

// Simple in‑memory session store (token → email)
const sessions = {};

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    // Find user by username
    const scanCmd = new ScanCommand({ TableName: 'Users', FilterExpression: 'username = :u', ExpressionAttributeValues: { ':u': username } });
    const result = await ddb.send(scanCmd);
    const user = result.Items && result.Items[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Generate session token
    const token = randomBytes(24).toString('hex');
    sessions[token] = user.userId;
    // Return token (client should store and send as Bearer token)
    res.json({ message: 'Login successful', token, userId: user.userId });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign‑up endpoint – stores user credentials in DynamoDB Users table
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    // Check if username already exists
    const scanCmd = new ScanCommand({ TableName: 'Users', FilterExpression: 'username = :u', ExpressionAttributeValues: { ':u': username } });
    const existing = await ddb.send(scanCmd);
    if (existing.Items && existing.Items.length > 0) {
      return res.status(409).json({ error: 'username already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = randomBytes(16).toString('hex');
    const putCmd = new PutCommand({
      TableName: 'Users',
      Item: { userId, username, passwordHash: hashedPassword },
    });
    await ddb.send(putCmd);
    res.json({ message: 'signup successful', userId });
  } catch (e) {
    console.error('Signup error:', e);
    res.status(500).json({ error: 'Error processing signup' });
  }
});

// 5. /create – form to create a quiz or trivia entry, with optional image upload
app.get('/create', (req, res) => {
  const html = `
    <h2>Create Quiz / Trivia</h2>
    <form method="POST" action="/create" enctype="multipart/form-data">
      <label>Type: 
        <select name="type" required>
          <option value="quiz">Quiz</option>
          <option value="trivia">Trivia</option>
        </select>
      </label><br>
      <label>Title (for quiz) / Question (for trivia):<br>
        <input type="text" name="title" required style="width:300px;">
      </label><br>
      <label>Description / Answer:<br>
        <textarea name="content" rows="4" cols="50" required></textarea>
      </label><br>
      <label>Image (optional): <input type="file" name="image" accept="image/*"></label><br>
      <button type="submit">Submit</button>
    </form>
    <a href="/">← Back to Home</a>
  `;
  res.send(baseStyle + html);
});

app.post('/create', upload.any(), async (req, res) => {
  const { type, title, content, questions } = req.body;
  // Gather uploaded files by field name
  const filesByField = {};
  if (req.files) {
    req.files.forEach(f => { filesByField[f.fieldname] = f; });
  }
  // Handle optional global image (field name "image")
  let globalImageUrl = null;
  if (filesByField['image']) {
    const img = filesByField['image'];
    const key = `${type}/${Date.now()}_${img.originalname}`;
    const putObj = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: img.buffer,
      ContentType: img.mimetype,
    });
    try {
      await s3.send(putObj);
      globalImageUrl = `https://${bucketName}.s3.${awsRegion}.amazonaws.com/${key}`;
    } catch (e) {
      console.error('S3 upload error (global image):', e);
      return res.status(500).send('Failed to upload global image');
    }
  }

  // Parse optional questions JSON (array of {question, choices:[4], correctIndex})
  let questionArray = [];
  if (questions) {
    try {
      questionArray = typeof questions === 'string' ? JSON.parse(questions) : questions;
    } catch (e) {
      console.error('Failed to parse questions JSON', e);
      return res.status(400).send('Invalid questions format');
    }
  }
  // Process per‑question images (field names like q_0_image, q_1_image, ...)
  for (let i = 0; i < questionArray.length; i++) {
    const field = `q_${i}_image`;
    if (filesByField[field]) {
      const img = filesByField[field];
      const key = `${type}/question_${i}/${Date.now()}_${img.originalname}`;
      const putObj = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: img.buffer,
        ContentType: img.mimetype,
      });
      try {
        await s3.send(putObj);
        const imageUrl = `https://${bucketName}.s3.${awsRegion}.amazonaws.com/${key}`;
        // Attach image URL to the corresponding question object
        if (typeof questionArray[i] === 'object' && questionArray[i] !== null) {
          questionArray[i].imageUrl = imageUrl;
        }
      } catch (e) {
        console.error('S3 upload error (question image):', e);
        return res.status(500).send('Failed to upload question image');
      }
    }
  }

  // Save the quiz or trivia to DynamoDB
  const item = {
    id: randomBytes(16).toString('hex'),
    type,
    title,
    content,
    ...(globalImageUrl && { imageUrl: globalImageUrl }),
    ...(questionArray.length && { questions: questionArray })
  };
  // If user is authenticated, set creatorId (for quizzes)
  if (req.userId) {
    item.creatorId = req.userId;
  }
  const putCmd = new PutCommand({
    TableName: type === 'quiz' ? 'Quizzes' : 'Trivia',
    Item: item
  });
  try {
    await ddb.send(putCmd);
    res.send(`Created ${type} successfully. <a href="/">Home</a>`);
  } catch (e) {
    console.error('DynamoDB put error:', e);
    res.status(500).send('Failed to save to DynamoDB');
  }
});

// 6. /gradeQuiz – invoke GradeQuiz Lambda to grade a completed quiz
app.post('/gradeQuiz', async (req, res) => {
  const payload = req.body; // Expect quizId, answers, etc.
  try {
    const { statusCode, result } = await invokeLambda('GradeQuiz', payload);
    if (statusCode === 200) {
      res.json({ success: true, grade: result });
    } else {
      res.status(500).json({ success: false, error: 'Lambda invocation failed', details: result });
    }
  } catch (e) {
    console.error('GradeQuiz error:', e);
    res.status(500).json({ success: false, error: 'Exception invoking Lambda' });
  }
});

// 7. /cleanupSessions – invoke CleanupSessions Lambda to clean stale sessions
app.post('/cleanupSessions', async (req, res) => {
  try {
    const { statusCode, result } = await invokeLambda('CleanupSessions', {});
    if (statusCode === 200) {
      res.json({ success: true, result });
    } else {
      res.status(500).json({ success: false, error: 'Cleanup Lambda failed', details: result });
    }
  } catch (e) {
    console.error('CleanupSessions error:', e);
    res.status(500).json({ success: false, error: 'Exception invoking Cleanup Lambda' });
  }
});

app.listen(port, () => {
  console.log(`Brain Brawl app listening at http://localhost:${port}`);
});
