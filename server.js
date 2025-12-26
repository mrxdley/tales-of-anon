// server.js - Your /diary/ backend
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const crypto = require('crypto');

const app = express();
const PORT = 3001;

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
function getMemoriesForContext() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT memory_text FROM memories 
       ORDER BY created_at DESC 
       LIMIT 6`,
      [],
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
  console.log('Clear command triggered!');

    //clearing
    db.serialize(() => {
      db.run('DELETE FROM entries', function(err) {
        if (err) {
          console.error('Delete failed:', err); //deletes entries
        }
      });
      db.run('DELETE FROM sqlite_sequence WHERE name="entries"', function(err) {
        if (err) {
          console.error('Reset sequence failed:', err); //deletes and resets
        } else {
          console.log('ID counter reset to 1');
        }
      });
      db.run('DELETE FROM memories', function(err) {
          if (err) {
            console.error('Delete memories failed:', err); //deletes memories
          }
        });
      db.run('DELETE FROM sqlite_sequence WHERE name="memories"', function(err) {
          if (err) {
            console.error('Reset sequence failed:', err);//deletes them too
          }
        });
    });

    db.run('DELETE FROM entries', function(err) {
      if (err) {
        console.error('Clear failed:', err);
        return res.status(500).json({ error: 'Clear failed' });
      }
      console.log('Database cleared by admin command');
      res.json({ message: 'All entries deleted. Database cleared.' });
    });

    return;
  }

  if (req.body.sub?.trim().toLowerCase() === "memory") {
    console.log('Memory dump requested');

    db.all('SELECT * FROM memories ORDER BY created_at DESC', [], (err, rows) => {
      if (err) {
        console.error('Memory dump failed:', err);
        return res.status(500).json({ error: 'Failed to fetch memories' });
      }

      if (rows.length === 0) {
        const emptyGreentext = '>be me\n>no memories yet\n>mfw empty mind';
        return res.json({
          id: Date.now(),  // fake ID so frontend treats it like a real post
          greentext: emptyGreentext,
          name: 'Anonymous',
          sub: 'Memory Dump',
          created_at: new Date().toISOString()
        });
      }

      let lines = ['>be me', '>memory dump activated', '>all key memories from the diary:'];

      rows.forEach(row => {
        const date = new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
        const memory = row.memory_text || row.key_memory || row.memory || 'unknown memory';
        lines.push(`>${date}: ${memory}`);
      });

      lines.push('>mfw reliving the entire arc');
      lines.push('>end of memory dump');

      const greentext = lines.join('\n');

      res.json({
        id: Date.now(),  // fake but unique ID
        greentext: greentext,
        name: 'Anonymous',
        sub: 'Memory Dump',
        created_at: new Date().toISOString()
      });
    });

  return; // prevent normal insert
  }
  
  if (!content || content.trim() === '') {
    return res.status(400).json({ error: 'Content is required' });
  } 

  try {
    const previousMemories = await getMemoriesForContext();
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
  5. Occasionally use format like: emotion.fileextension
  6. After the greentext, on a new line, write 1 short summary about the user's patterns/habits/emotions but only IF they are MAJOR OR IMPORTANT
  7. Format each memory as: [memory: short memory text]
  8. every memory must have a unique topic

  Example:
  > be me
  > try to wake up early
  > alarmClockScreaming.mp3
  > hit snooze 5 times
  > mfw it's already noon
  
  [memory: always hits snooze multiple times]
  [memory: struggles with morning routines]

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
        temperature: 0.8,
        max_tokens: 1800
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
                'INSERT INTO memories (memory_text, entry_id) VALUES (?, ?)',
                [memory.trim(), entryId],
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