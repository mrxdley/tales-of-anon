// server.js - Your /diary/ backend
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 3001;

// Check for command-line flag --rate-limit or --no-rate-limit
const args = process.argv.slice(2);
const enableRateLimit = args.includes('--rate-limit') && !args.includes('--no-rate-limit');
console.log(`Rate limiting ${enableRateLimit ? 'ENABLED' : 'DISABLED'}`);

if (enableRateLimit) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,     // 15 minutes
    max: 10,                     // limit each IP to 100 requests per window
    standardHeaders: true,        // Return rate limit info in headers
    legacyHeaders: false,         // Disable X-RateLimit headers
    message: 'Too many requests from this IP, please try again later.',
    // Optional: skip for your IP (uncomment and set your home IP)
    // skip: (req) => req.ip === 'YOUR_HOME_IP_HERE'
  });

  // Apply to API routes only
  app.use('/api/', limiter);
}

// Middleware
app.use(cors());
app.use(express.json());

// Initialize SQLite database
const db = new sqlite3.Database('./diary.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to diary database');
    // Create entries table if it doesn't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        greentext TEXT
      )
    `);
  }
});

// ---- memory system----
// First, modify getMemoriesForContext to return a Promise instead of using callbacks
function getMemoriesForContext(deviceId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT memory_text FROM memories 
       WHERE device_id = ?
       ORDER BY created_at DESC 
       LIMIT 6`,
      [deviceId],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const memories = rows.map(row => row.memory_text);
          resolve(memories);
        }
      }
    );
  });
}

function extractMemoriesFromResponse(response) {
  const memories = [];
  const memoryRegex = /\[memory:\s*(.+?)\]/gi;
  let match;
  
  while ((match = memoryRegex.exec(response)) !== null) {
    const memory = match[1].trim();
    if (memory.length > 0 && memory.length < 100) {
      memories.push(memory);
    }
  }
  
  return memories;
}



// API Routes

// Get all entries
app.get('/api/entries', (req, res) => {
  const deviceId = req.headers['x-device-id'] || req.query.device_id || 'default';

  db.all('SELECT * FROM entries WHERE device_id = ? ORDER BY created_at DESC', [deviceId], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ entries: rows });
  });
});

// Get single entry
app.get('/api/entries/:id', (req, res) => {
  db.get('SELECT * FROM entries WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ entry: row });
  });
});

// Get all memories
app.get('/api/memories', (req, res) => {
  db.all(`
    SELECT m.*, e.content as source_content 
    FROM memories m
    LEFT JOIN entries e ON m.entry_id = e.id
    ORDER BY m.created_at DESC
  `, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ memories: rows });
  });
});

app.post('/api/entries', async (req, res) => {
  const { content, options, name, sub } = req.body;

  // Get or create device ID from cookie or header
  let deviceId = req.headers['x-device-id'] || 'default';
  // If no header, generate one (but better from frontend — see below)
  if (deviceId === 'default') {
    deviceId = crypto.randomUUID();  // fallback
  }

  console.log('Received body:', req.body);  // log entire payload

if (req.body.options?.trim().toLowerCase() === 'clear') {
  const deviceId = req.body.device_id || 'default';
  console.log('Clear command triggered for device:', deviceId);

  db.serialize(() => {
    // Delete only this device's entries
    db.run('DELETE FROM entries WHERE device_id = ?', [deviceId], function(err) {
      if (err) console.error('Delete entries failed:', err);
      else console.log(`Deleted ${this.changes} entries for device`);
    });

    // Reset auto-increment only if no entries left for this device (optional, safe)
    // SQLite doesn't support per-device reset easily, so we skip counter reset
    // or you can live with global counter — it's fine for public use

    // Delete only this device's memories
    db.run('DELETE FROM memories WHERE device_id = ?', [deviceId], function(err) {
      if (err) console.error('Delete memories failed:', err);
      else console.log(`Deleted ${this.changes} memories for device`);
    });
  });

  // Send success response
  res.json({ 
    message: `Diary cleared for this device only. ${deviceId === 'default' ? '(default)' : ''}` 
  });

  return; // stop normal posting
}

  if (req.body.options?.trim().toLowerCase() === "memory") {
    console.log('Memory recall requested');

    db.all('SELECT * FROM memories WHERE device_id = ? ORDER BY created_at DESC', [deviceId], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch memories' });
      }

      let lines = ['>be me', '>memory recall activated', '>my memories so far:'];

      if (rows.length === 0) {
        lines.push('>no memories yet');
        lines.push('>mfw blank slate');
      } else {
        rows.forEach(row => {
          const date = new Date(row.created_at).toLocaleDateString();
          const memory = row.memory_text || row.text || 'unknown memory';
          lines.push(`>${date}: ${memory}`);
        });
      }

      lines.push('>mfw this is who I am now');
      const greentext = lines.join('\n');

      db.run(
        'INSERT INTO entries (content, greentext, name, sub, device_id) VALUES (?, ?, ?, ?,?)',
        [content.trim(), greentext, req.body.name || 'Anonymous', req.body.sub || '', deviceId],
        function(err) {
          if (err) {
            console.error('DB error:', err);
            return res.status(500).json({ error: 'Failed to save entry' });
          }
          
          const entryId = this.lastID;
          
          res.json({
            id: entryId,
            content: content.trim(),
            greentext,
            memories: '',
            name: req.body.name || 'Anonymous',
            sub: req.body.sub || '',
            created_at: new Date().toISOString()
          });
        }
      );

    });

    return; // stop normal flow
  }
  
  if (!content || content.trim() === '') {
    return res.status(400).json({ error: 'Content is required' });
  } 

  try {
    const previousMemories = await getMemoriesForContext(deviceId);
    let memoryContext = '';
    if (previousMemories.length > 0) {
      memoryContext = '\n\nUser\'s previous key memories:\n';
      previousMemories.forEach((memory, index) => {
        memoryContext += `${index + 1}. ${memory}\n`;
      });
    }

      const prompt = `You are anon's diary assistant. Turn journal entries into 4chan-style greentext stories.

   ${memoryContext}

  INSTRUCTIONS:
  1. Create a greentext story from the journal entry
  2. Use > at the start of every line
  3. Make it funny, ironic, self-deprecating
  4. End with "mfw" or "tfw" if appropriate
  4. ONLY If the journal entry is longer than 5 lines, write an appropriate comment/observation after the greentext from the perspective of the user, without the >
  5. Occasionally use format like: emotion.fileextension
  6. After the greentext, on a new line, write 1 short summary about the user's patterns/habits/emotions but only IF they are MAJOR OR IMPORTANT
  7. Format each memory as: [memory: short memory text]
  8. NEVER EVER CREATE DUPLICATE MEMORIES
  9. NEVER EVER REFER TO "the user"

  Example:
  > be me
  > try to wake up early
  > alarmClockScreaming.mp3
  > hit snooze 5 times
  > mfw it's already noon

  Am I really going to live like this forever?
  
  [memory: always hits snooze multiple times]

  Now process this journal entry: ${content.trim()}`;

    const llmResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'HTTP-Referer': 'http://localhost:3001',  // or your domain
        'X-Title': '/diary/'
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.85,
        max_tokens: 800
      })
    });

    if (!llmResponse.ok) {
      const errText = await llmResponse.text();
      console.error('LLM failed:', llmResponse.status, errText);
      throw new Error(`LLM ${llmResponse.status}`);
    }

    const data = await llmResponse.json();
    const fullResponse = data.choices[0].message.content.trim();
    
    const memoryStart = fullResponse.search(/\[memory:/i);
    let greentext, extractedMemories = [];

    if (memoryStart !== -1) {
        greentext = fullResponse.substring(0, memoryStart).trim();
        extractedMemories = extractMemoriesFromResponse(fullResponse);
      } else {
        greentext = fullResponse;
      }
    
    // Save the entry
    db.run(
      'INSERT INTO entries (content, greentext, name, sub, device_id) VALUES (?, ?, ?, ?,?)',
      [content.trim(), greentext, req.body.name || 'Anonymous', req.body.sub || '', deviceId],
      function(err) {
        if (err) {
          console.error('DB error:', err);
          return res.status(500).json({ error: 'Failed to save entry' });
        }
        
        const entryId = this.lastID;
        
        if (extractedMemories.length > 0) {
          console.log('Saving memories:', extractedMemories);
          
          extractedMemories.forEach(memory => {
            if (memory && memory.trim().length > 0) {
              db.run(
                'INSERT INTO memories (memory_text, entry_id, device_id) VALUES (?, ?,?)',
                [memory.trim(), entryId, deviceId],
                (err) => {
                  if (err) {
                    console.error('FAILED to save memory:', err);
                  } else {
                    console.log('✓ Saved memory:', memory.trim());
                  }
                }
              );
            }
          });
        } else {
          console.log('No memories extracted from this entry');
        }
        
        res.json({
          id: entryId,
          content: content.trim(),
          greentext,
          memories: extractedMemories,
          name: req.body.name || 'Anonymous',
          sub: req.body.sub || '',
          created_at: new Date().toISOString()
        });
      }
    );

  } catch (err) {
    console.error('LLM call failed, using fallback:', err);
    greentext = content.trim()
      .split('\n')
      .map(line => `>${line.trim() || 'be me'}`)
      .join('\n');
  }
});

// Delete entry
app.delete('/api/entries/:id', (req, res) => {
  db.run('DELETE FROM entries WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ message: 'Entry deleted', changes: this.changes });
  });
});


// Graceful shutdown
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Database connection closed.');
    process.exit(0);
  });
});

// Serve React app
app.use(express.static(path.join(__dirname, 'build')));

// Handle client-side routing — send index.html for any non-API route
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`/diary/ server running on http://localhost:${PORT}`);
});