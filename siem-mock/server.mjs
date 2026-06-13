#!/usr/bin/env node
/**
 * Mock SIEM — Splunk HEC receiver (untuk uji jalur exporter, BUKAN SIEM nyata).
 * Menerima POST /services/collector(/event|/raw) format Splunk HEC,
 * menulis tiap event ke /data/siem/hec-received.jsonl, balas {"text":"Success","code":0}.
 * Ganti dengan endpoint Splunk korporat saat siap (cukup ubah config exporter).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/data/siem';
fs.mkdirSync(OUT, { recursive: true });
const FILE = path.join(OUT, 'hec-received.jsonl');
const PORT = 8088;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"text":"HEC is healthy","code":17}');
  }
  if (req.method === 'POST' && req.url.includes('/services/collector')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let n = 0;
      try {
        // Splunk HEC = newline-delimited JSON event objects
        for (const line of body.split('\n')) {
          if (!line.trim()) continue;
          fs.appendFileSync(FILE, line + '\n');
          n++;
        }
      } catch (e) {
        process.stdout.write(`[siem-mock] error: ${e.message}\n`);
      }
      process.stdout.write(`[siem-mock] indexed ${n} event(s)\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"text":"Success","code":0}');
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"text":"Not Found","code":404}');
});

server.listen(PORT, () => process.stdout.write(`[siem-mock] Splunk HEC mock listening on :${PORT}\n`));
