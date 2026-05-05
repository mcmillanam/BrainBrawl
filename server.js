require('dotenv').config();                                                                                    
  const express = require('express');                                                                            
  const { randomBytes } = require('crypto');                                                                     
  const bcrypt = require('bcrypt');                                                                              
  const {                                                                                                        
    DynamoDBClient,                                                                                              
  } = require('@aws-sdk/client-dynamodb');                                                                       
  const {                                                                                                        
    DynamoDBDocumentClient,                                                                                      
    PutCommand,                                                                                                  
    GetCommand,                                                                                                  
    QueryCommand,                                                                                                
    ScanCommand,                                                                                                 
    UpdateCommand,                                                                                               
  } = require('@aws-sdk/lib-dynamodb');                                                                          
  const {                                                                                                        
    S3Client,                                                                                                    
    PutObjectCommand,                                                                                            
  } = require('@aws-sdk/client-s3');                                                                             
  const path = require('path');                                                                                  
                                                                                                                 
  const app = express(); 
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage() });
                                                                                                                 
  // ---------- Configuration ----------                                                                         
  const PORT = process.env.PORT || 3000;                                                                         
  const HOST = '0.0.0.0';                                                                                        
                                                                                                                 
  // AWS region – default to us‑east‑1 if not set in .env                                                        
  const REGION = process.env.AWS_REGION || 'us-east-1';                                                          
                                                                                                                 
  // DynamoDB client (uses the instance’s IAM role)                                                              
  const ddbClient = new DynamoDBClient({ region: REGION });                                                      
  const ddb = DynamoDBDocumentClient.from(ddbClient);                                                           
                                                                                                                 
  // S3 client (also uses IAM role)                                                                              
  const s3 = new S3Client({ region: REGION });                                                                   
  const BUCKET = 'brain-brawl-assets-mcmillanam';                                                                
                                                                                                                 
  // ---------- Middleware ----------                                                                            
  app.use(express.static(path.join (__dirname, 'public')));                                                      
  app.use(express.json());               // parse application/json                                               
  app.use(express.urlencoded({ extended: false })); // form‑urlencoded                                           
                                                                                                                 
  // ---------- Helper Functions ----------                                                                      
  function makeId() {                                                                                            
    // 16‑byte hex string → 32 characters – good enough for demo IDs                                             
    return randomBytes(16).toString('hex');                                                                      
  }                                                                                                              
                                                                                                                 
  // ---------- Auth Endpoints ----------                                                                        
  app.post('/signup', async (req, res) => {
	  console.log("=== SIGNUP HIT ===");
	  console.log("BODY:", req.body);
	  console.log("URL:", req.url);
    const { username, password } = req.body;                                                                     
    if (!username || !password) {                                                                                
      return res.status(400).json({ error: 'username and password required' });                                  
    }                                                                                                            
                                                                                                                 
    try {
      const scan = new ScanCommand({
	      TableName: 'Users',
	      FilterExpression: 'username = :u',
	      ExpressionAttributeValues: {
		      ':u': username
	      }
	});
      const existing = await ddb.send(scan);
      if (existing.Items && existing.Items.length > 0) {
	      return res.status(409).json({ error: 'username already taken' });
      }
      const hashed = await bcrypt.hash(password, 10);                                                            
      const put = new PutCommand({                                                                               
        TableName: 'Users',                                                                                      
        Item: {                                                                                                  
          userId: makeId(),                                                                                      
          username,                                                                                              
          password: hashed,                                                                                      
        },                                                                                                       
      });                                                                                                        
      await ddb.send(put);                                                                                       
      res.json({ message: 'signup successful' });                                                                
    } catch (e) {                                                                                                
      console.error('Signup error:', e);                                                                                                 
      res.status(500).json({ error: 'internal server error' });                                                  
    }                                                                                                            
  });                                                                                                            
                                                                                                                 
  app.post('/login', async (req, res) => {                                                                       
    const { username, password } = req.body;                                                                     
    if (!username || !password) {                                                                                
      return res.status(400).json({ error: 'username and password required' });                                  
    }                                                                                                            
                                                                                                                 
    try {                                                                                                        
      // Find the user by scanning the Users table (small table → OK for demo)                                   
      const scan = new ScanCommand({                                                                             
        TableName: 'Users',                                                                                      
        FilterExpression: 'username = :u',                                                                       
        ExpressionAttributeValues: { ':u': username },                                                           
      });                                                                                                        
      const { Items } = await ddb.send(scan);                                                                    
      if (!Items || Items.length === 0) {                                                                        
        return res.status(404).json({ error: 'user not found' });                                                
      }                                                                                                          
      const user = Items[0];                                                                                     
      const match = await bcrypt.compare(password, user.password);                                               
      if (!match) {                                                                                              
        return res.status(401).json({ error: 'invalid password' });                                              
      }                                                                                                          
      // For the MVP we just return the userId; a real app would issue a JWT or session cookie.                  
      res.json({ message: 'login successful', userId: user.userId });                                            
    } catch (e) {                                                                                                
      console.error('Login error:', e);                                                                          
      res.status(500).json({ error: 'internal server error' });                                                  
    }                                                                                                            
  });                                                                                                            
                                                                                                                 
  // ---------- Quiz Endpoints ----------                                                                        
  app.post('/quiz', async (req, res) => {                                                                        
    const { title, creatorId, questions } = req.body;                                                            
    if (!title || !creatorId || !Array.isArray(questions) || questions.length === 0) {                           
      return res.status(400).json({ error: 'invalid quiz payload' });                                            
    }                                                                                                            
                                                                                                                 
    // Basic validation of each question                                                                         
    for (const q of questions) {                                                                                 
      if (!q.text || !Array.isArray(q.choices) || q.choices.length < 2 || q.correctAnswer === undefined) {       
        return res.status(400).json({ error: 'malformed question object' });                                     
      }                                                                                                          
    }                                                                                                            
                                                                                                                 
    const quizId = makeId();                                                                                     
    const put = new PutCommand({                                                                                 
      TableName: 'Quizzes',                                                                                      
      Item: {                                                                                                    
        quizId,                                                                                                  
        title,                                                                                                   
        creatorId,                                                                                               
        questions, // we store the full object (including correctAnswer) – will be stripped on GET               
      },                                                                                                         
    });                                                                                                          
                                                                                                                 
    try {                                                                                                        
      await ddb.send(put);                                                                                       
      res.json({ message: 'quiz created', quizId });                                                             
    } catch (e) {                                                                                                
      console.error('Create quiz error:', e);                                                                    
      res.status(500).json({ error: 'internal server error' });                                                  
    }                                                                                                            
  });                                                                                                            
                                                                                                                 
  app.get('/quiz/:id', async (req, res) => {                                                                     
    const quizId = req.params.id;                                                                                
    try {                                                                                                        
      const get = new GetCommand({                                                                               
        TableName: 'Quizzes',                                                                                    
        Key: { quizId },                                                                                         
      });                                                                                                        
      const { Item } = await ddb.send(get);                                                                      
      if (!Item) {                                                                                               
        return res.status(404).json({ error: 'quiz not found' });                                                
      }                                                                                                          
                                                                                                                 
      // Strip correctAnswer before sending to player                                                            
      const safeQuestions = Item.questions.map(q => ({                                                           
        text: q.text,                                                                                            
        choices: q.choices,                                                                                      
        imageUrl: q.imageUrl, // optional                                                                        
      }));                                                                                                       
                                                                                                                 
      const { correctAnswer, ...rest } = Item; // drop any stray field just in case                              
      res.json({ ...rest, questions: safeQuestions });                                                           
    } catch (e) {                                                                                                
      console.error('Get quiz error:', e);                                                                       
      res.status(500).json({ error: 'internal server error' });                                                  
    }                                                                                                            
  });                                                                                                            
                                                                                                                 
  // ---------- Gameplay ----------                                                                              
  app.post('/quiz/:id/submit', async (req, res) => {                                                             
    const quizId = req.params.id;                                                                                
    const { userId, answers } = req.body; // `answers` is array of chosen indices                                
                                                                                                                 
    if (!userId || !Array.isArray(answers)) {                                                                    
      return res.status(400).json({ error: 'userId and answers required' });                                     
    }                                                                                                            
                                                                                                                 
    try {                                                                                                        
      // Load the quiz (including correctAnswer)                                                                 
      const get = new GetCommand({                                                                               
        TableName: 'Quizzes',                                                                                    
        Key: { quizId },                                                                                         
      });                                                                                                        
      const { Item } = await ddb.send(get);                                                                      
      if (!Item) {                                                                                               
        return res.status(404).json({ error: 'quiz not found' });                                                
      }                                                                                                          
                                                                                                                 
      // Score calculation                                                                                       
      const correct = Item.questions.map(q => q.correctAnswer);                                                  
      let score = 0;                                                                                             
      for (let i = 0; i < correct.length; i++) {                                                                 
        if (answers[i] !== undefined && answers[i] === correct[i]) score++;                                      
      }                                                                                                          
                                                                                                                 
      // Store result in Leaderboard                                                                             
      const put = new PutCommand({                                                                               
        TableName: 'Leaderboard',                                                                                
        Item: {                                                                                                  
          quizId,                                                                                                
          userId,                                                                                                
          score,                                                                                                 
          timestamp: Date.now(),                                                                                 
        },                                                                                                       
      });                                                                                                        
      await ddb.send(put);                                                                                       
                                                                                                                 
      res.json({ message: 'submission received', score });                                                       
    } catch (e) {                                                                                                
      console.error('Submit quiz error:', e);                                                                    
      res.status(500).json({ error: 'internal server error' });                                                  
    }                                                                                                            
  });                                                                                                            
                                                                                                                 
  // ---------- Leaderboard ----------                                                                           
  // ---------- Leaderboard ----------
app.get('/leaderboard/:quizId', async (req, res) => {
  const quizId = req.params.quizId;

  try {
    const scan = new ScanCommand({
      TableName: 'Leaderboard',
      FilterExpression: 'quizId = :q',
      ExpressionAttributeValues: {
        ':q': quizId
      }
    });

    const result = await ddb.send(scan);

    const sorted = (result.Items || []).sort((a, b) => b.score - a.score);

    res.json(sorted);
  } catch (e) {
    console.error('Leaderboard error:', e);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/quizzes', async (req, res) => {
	try {
		const scan = new ScanCommand({
			TableName: 'Quizzes'
		});
		const result = await ddb.send(scan);
		const safeQuizzes = (result.Items || []).map(q => ({
			quizId: q.quizId,
			title: q.title,
			creatorId: q.creatorId
		}));
		res.json(safeQuizzes);
	} catch (e) {
		console.error('Get quizzes error:', e);
		res.status(500).json({ error: 'failed to load quizzes' });
	}
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on port ${PORT}`);
});                                   
