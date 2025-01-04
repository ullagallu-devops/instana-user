const instanaAvailable = process.env.INSTANA_AGENT_AVAILABLE === 'true';
let instana;
if (instanaAvailable) {
    instana = require('@instana/collector')({
        agentHost: process.env.INSTANA_AGENT_HOST || 'localhost',
        tracing: { enabled: true }
    });
    console.log("Instana initialized.");
} else {
    console.log("Instana not initialized as agent is unavailable.");
}

const { MongoClient, ObjectId } = require('mongodb');
const { createClient } = require('redis');
const bodyParser = require('body-parser');
const express = require('express');
const pino = require('pino');
const expPino = require('express-pino-logger');

// MongoDB
let db;
let usersCollection;
let ordersCollection;
let mongoConnected = false;

const logger = pino({
    level: 'info',
    prettyPrint: false,
    useLevelLabels: true
});
const expLogger = expPino({
    logger: logger
});

const app = express();
app.use(expLogger);

// CORS headers
app.use((req, res, next) => {
    res.set('Timing-Allow-Origin', '*');
    res.set('Access-Control-Allow-Origin', '*');
    next();
});

// Custom annotation for Instana
app.use((req, res, next) => {
    if (instana) { // Check if instana is initialized
        let dcs = [
            "asia-northeast2",
            "asia-south1",
            "europe-west3",
            "us-east1",
            "us-west1"
        ];
        let span = instana.currentSpan();
        if (span) { // Ensure span is defined
            span.annotate('custom.sdk.tags.datacenter', dcs[Math.floor(Math.random() * dcs.length)]);
        }
    }
    next();
});

// Middleware for body parsing
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Health check endpoint
app.get('/health', async (req, res) => {
    const redisStatus = await redisClient.ping().then(() => 'connected').catch(() => 'not connected');
    const stat = {
        app: 'OK',
        mongo: mongoConnected,
        redis: redisStatus
    };
    res.json(stat);
});

// Unique ID endpoint using Redis
app.get('/uniqueid', async (req, res) => {
    try {
        const r = await redisClient.incr('anonymous-counter');
        res.json({
            uuid: 'anonymous-' + r
        });
    } catch (err) {
        req.log.error('ERROR', err);
        res.status(500).send(err);
    }
});

// Check if user exists
app.get('/check/:id', async (req, res) => {
    if (mongoConnected) {
        try {
            const user = await usersCollection.findOne({ name: req.params.id });
            if (user) {
                res.send('OK');
            } else {
                res.status(404).send('User not found');
            }
        } catch (e) {
            req.log.error(e);
            res.status(500).send(e);
        }
    } else {
        req.log.error('Database not available');
        res.status(500).send('Database not available');
    }
});

// Return all users for debugging
app.get('/users', async (req, res) => {
    if (mongoConnected) {
        try {
            const users = await usersCollection.find().toArray();
            res.json(users);
        } catch (e) {
            req.log.error('ERROR', e);
            res.status(500).send(e);
        }
    } else {
        req.log.error('Database not available');
        res.status(500).send('Database not available');
    }
});

// User login
app.post('/login', async (req, res) => {
    req.log.info('login', req.body);
    if (!req.body.name || !req.body.password) {
        req.log.warn('Credentials not complete');
        res.status(400).send('Name or password not supplied');
    } else if (mongoConnected) {
        try {
            const user = await usersCollection.findOne({ name: req.body.name });
            req.log.info('user', user);
            if (user) {
                if (user.password === req.body.password) {
                    res.json(user);
                } else {
                    res.status(404).send('Incorrect password');
                }
            } else {
                res.status(404).send('Name not found');
            }
        } catch (e) {
            req.log.error('ERROR', e);
            res.status(500).send(e);
        }
    } else {
        req.log.error('Database not available');
        res.status(500).send('Database not available');
    }
});

// User registration
app.post('/register', async (req, res) => {
    req.log.info('register', req.body);
    if (!req.body.name || !req.body.password || !req.body.email) {
        req.log.warn('Insufficient data');
        res.status(400).send('Insufficient data');
    } else if (mongoConnected) {
        try {
            const user = await usersCollection.findOne({ name: req.body.name });
            if (user) {
                req.log.warn('User already exists');
                res.status(400).send('Name already exists');
            } else {
                const r = await usersCollection.insertOne({
                    name: req.body.name,
                    password: req.body.password,
                    email: req.body.email
                });
                req.log.info('Inserted', r.result);
                res.send('OK');
            }
        } catch (e) {
            req.log.error('ERROR', e);
            res.status(500).send(e);
        }
    } else {
        req.log.error('Database not available');
        res.status(500).send('Database not available');
    }
});

// Place an order
app.post('/order/:id', async (req, res) => {
    req.log.info('order', req.body);
    if (mongoConnected) {
        try {
            const user = await usersCollection.findOne({ name: req.params.id });
            if (user) {
                const history = await ordersCollection.findOne({ name: req.params.id });
                if (history) {
                    const list = history.history;
                    list.push(req.body);
                    await ordersCollection.updateOne(
                        { name: req.params.id },
                        { $set: { history: list } }
                    );
                    res.send('OK');
                } else {
                    await ordersCollection.insertOne({
                        name: req.params.id,
                        history: [req.body]
                    });
                    res.send('OK');
                }
            } else {
                res.status(404).send('Name not found');
            }
        } catch (e) {
            req.log.error(e);
            res.status(500).send(e);
        }
    } else {
        req.log.error('Database not available');
        res.status(500).send('Database not available');
    }
});

// Get order history
app.get('/history/:id', async (req, res) => {
    if (mongoConnected) {
        try {
            const history = await ordersCollection.findOne({ name: req.params.id });
            if (history) {
                res.json(history);
            } else {
                res.status(404).send('History not found');
            }
        } catch (e) {
            req.log.error(e);
            res.status(500).send(e);
        }
    } else {
        req.log.error('Database not available');
        res.status(500).send('Database not available');
    }
});

// Connect to Redis
const redisHost = process.env.REDIS_HOST || 'localhost'; // Use REDIS_HOST if defined
const redisClient = createClient({
    url: `redis://${redisHost}:6379` // Use the resolved redisHost here
});

redisClient.on('error', (e) => {
    logger.error('Redis ERROR', e);
    logger.error(`Attempted Redis connection to: ${`redis://${redisHost}:6379`}`);
});
redisClient.on('connect', () => {
    logger.info('Redis connected');
});
redisClient.connect();

// Set up MongoDB connection
async function mongoConnect() {
    try {
        const mongoURL = process.env.MONGO_URL || 'mongodb://localhost:27017/users';
        const client = await MongoClient.connect(mongoURL); // Removed deprecated options
        db = client.db('users');
        usersCollection = db.collection('users');
        ordersCollection = db.collection('orders');
        mongoConnected = true;
        logger.info('MongoDB connected');
    } catch (e) {
        logger.error('MongoDB connection ERROR', e);
        mongoConnected = false;
    }
}

mongoConnect();

// Start the server
const port = process.env.PORT || 8080;
app.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
});
