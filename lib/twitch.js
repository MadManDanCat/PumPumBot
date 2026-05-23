'use strict';
// Single Twitch IRC connection (main process).
//  - No token  -> anonymous justinfan (read only) — TTS still works.
//  - Token set -> authed connection (read AND write) for the bot.
// Emits: 'status'(state,label), 'message'({user,login,text,flags}), 'ready'
// Sending is rate-limited (Twitch: ~20 msgs / 30s for a normal/mod account).

const EventEmitter = require('events');
const WebSocket = require('ws');

const SEND_INTERVAL_MS = 1600; // ~18 msgs / 30s — safely under the 20 cap

class Twitch extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.channel = null;
    this.botUser = null;
    this.token = null;       // raw, with or without leading "oauth:"
    this.ignoreLogins = new Set();   // logins the reader must never process
    this.connected = false;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.sendQueue = [];
    this.sendTimer = null;
  }

  configure({ channel, botUser, token, ignoreUsers }) {
    // Twitch logins are lowercase a-z0-9_ only — strip anything else so a
    // stray space or capital ("PumPum Bot") can't brick the connection.
    this.channel = (channel || '').trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
    this.botUser = (botUser || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    this.token = (token || '').trim().replace(/\s+/g, '');
    // Logins this connection must NEVER read or act on — the bot's own
    // account (so a separate/anonymous reader doesn't TTS the bot's banter)
    // plus any third-party bots (Nightbot, StreamElements, …). Normalized to
    // bare Twitch logins, same rules as a username.
    this.ignoreLogins = new Set(
      (Array.isArray(ignoreUsers) ? ignoreUsers : [])
        .map(u => String(u || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, ''))
        .filter(Boolean)
    );
  }

  // The token IS the identity. A username is no longer required — we read
  // the real account from Twitch's login handshake (the 001 line).
  canWrite() { return !!this.token; }

  connect() {
    this.manualClose = false;
    if (!this.channel) { this.emit('status', 'disconnected', 'No channel'); return; }
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.emit('status', 'connecting', `Linking to ${this.channel}`);

    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;

    ws.on('open', () => {
      let nick, pass;
      if (this.canWrite()) {
        // Twitch authenticates by token; NICK is informational. Use the
        // typed username as a hint, fall back to a placeholder.
        nick = this.botUser || 'pumpumbot';
        pass = this.token.startsWith('oauth:') ? this.token : 'oauth:' + this.token;
      } else {
        nick = 'justinfan' + Math.floor(10000 + Math.random() * 80000);
        pass = 'SCHMOOPIIE';
      }
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS ' + pass);
      ws.send('NICK ' + nick);
      ws.send('JOIN #' + this.channel);
    });

    ws.on('message', (data) => {
      const text = data.toString();
      for (const line of text.split('\r\n')) this._handleLine(line);
    });

    ws.on('close', () => {
      this.connected = false;
      if (this.manualClose) { this.emit('status', 'disconnected', 'Disconnected'); return; }
      this.emit('status', 'connecting', 'Reconnecting');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    ws.on('error', () => { try { ws.close(); } catch {} });
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.connected = false;
    this.emit('status', 'disconnected', 'Disconnected');
  }

  _handleLine(line) {
    if (!line) return;
    if (line.startsWith('PING')) { this._raw('PONG' + line.slice(4)); return; }

    let tags = {};
    let rest = line;
    if (line.startsWith('@')) {
      const sp = line.indexOf(' ');
      const tagStr = line.slice(1, sp);
      rest = line.slice(sp + 1);
      for (const kv of tagStr.split(';')) {
        const i = kv.indexOf('=');
        tags[kv.slice(0, i)] = kv.slice(i + 1);
      }
    }

    // Successful auth / join. The 001 line carries the REAL authenticated
    // login: ":tmi.twitch.tv 001 <login> :Welcome, GLHF!"
    const m001 = rest.match(/^:tmi\.twitch\.tv 001 (\S+)/);
    if (m001 || rest.includes(' 001 ')) {
      this.connected = true;
      if (m001) this.authedAs = m001[1].toLowerCase();
      const mode = this.canWrite() ? 'Bot active' : 'Read only';
      this.emit('status', 'connected', `${this.channel} · ${mode}`);
      this.emit('ready');
      return;
    }
    // Bad auth — Twitch sends a NOTICE. Don't loop forever: fall back to
    // anonymous read so TTS keeps working, and tell the user clearly.
    if (/NOTICE \* :(Login authentication failed|Improperly formatted auth|Invalid NICK)/i.test(rest)
        || rest.includes('Login authentication failed')) {
      if (this.canWrite()) {
        this.emit('status', 'disconnected', 'Bot login failed — check username/token. Reading anonymously instead.');
        // Drop write creds and reconnect read-only so TTS still works.
        this.botUser = '';
        this.token = '';
        try { this.ws.close(); } catch {}
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 1500);
      } else {
        this.emit('status', 'disconnected', 'Login failed');
        this.manualClose = true;
        try { this.ws.close(); } catch {}
      }
      return;
    }

    const m = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #([^ ]+) :(.*)$/);
    if (!m) return;
    const login = m[1].toLowerCase();
    // Never process the bot's OWN messages — no TTS, no economy, no commands.
    // (Defense in depth: Twitch normally doesn't echo, but this guarantees
    //  the bot can never talk to itself or feed its replies into TTS.)
    if (this.authedAs && login === this.authedAs.toLowerCase()) return;
    // Same for ignored logins. This is what stops a read-only/anonymous TTS
    // reader from speaking the bot account's banter when the bot is a SEPARATE
    // login (e.g. pumpumbott) — the authedAs check above can't catch that.
    if (this.ignoreLogins.has(login)) return;
    const display = (tags['display-name'] && tags['display-name'].trim()) || m[1];
    const msg = m[3].replace(/[]/g, '').trim(); // strip /me markers
    const badges = tags.badges || '';
    const flags = {
      mod: tags.mod === '1' || badges.includes('moderator'),
      subscriber: tags.subscriber === '1' || badges.includes('subscriber') || badges.includes('founder'),
      vip: badges.includes('vip'),
      broadcaster: badges.includes('broadcaster'),
    };
    this.emit('message', { user: display, login, text: msg, flags });
  }

  _raw(s) { try { this.ws && this.ws.send(s); } catch {} }

  // Public: queue a chat message (rate-limited). No-op if not in write mode.
  say(text) {
    if (!this.canWrite() || !this.connected) return;
    const clean = String(text).replace(/[\r\n]+/g, ' ').slice(0, 480);
    if (!clean) return;
    this.sendQueue.push(clean);
    this._drain();
  }

  _drain() {
    if (this.sendTimer) return;
    const step = () => {
      const next = this.sendQueue.shift();
      if (next == null) { this.sendTimer = null; return; }
      this._raw(`PRIVMSG #${this.channel} :${next}`);
      this.sendTimer = setTimeout(step, SEND_INTERVAL_MS);
    };
    step();
  }
}

module.exports = new Twitch();
