'use strict';
// Stream banter pools. In-jokes from the channel:
//  - "egg and cress"  = cheap / weak effort
//  - "pum pum"         = the bot's namesake London slang (kept light)
//  - Sean / imstilldadaddy = "G", "the General", "the muvafukin Guvnah"
//  - "Mr X"            = the resident scrub who stream-snipes with Ken
// Placeholders: {winner} {loser} {user} {amount} {cur}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function fill(s, vars) {
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}
function line(pool, vars) { return fill(pick(pool), vars || {}); }

// Mid-fight action beats (name-free) — the "battle" part of a duel message.
const CLASH = [
  "Round 1 — FIGHT! Footsies war breaks out...",
  "Both rush in, trading blows mid-screen...",
  "Neutral skips, whiff punishes flying...",
  "It goes the full distance, last pixel of health...",
  "Reads on reads, nobody backing down...",
  "Jab war into a hard read...",
  "Corner pressure, escape attempt, scramble...",
  "Final round, both on fumes...",
];

// Name-free, amount-free tags — appended after a clean factual line so a
// name is never repeated and there's no @-spam.
const DUEL_WIN = [
  "Proper egg and cress effort, that.",
  "Muvafukin sparked. Couldn't bang, simple.",
  "Folded cheaper than an egg and cress sarnie.",
  "The Guvnah nods in approval. 👑",
  "Pure pum pum tings.",
  "Bum tier. Pressed buttons and prayed.",
  "Cleanly moved to. 🛑",
  "Egg and cress wages from here on.",
];

const DUEL_BOT_WIN = [   // player beat the bot
  "Sheesh — the moves are real. 🕺",
  "Bot got muvafukin sparked.",
  "Took the machine to school. 🥪",
  "G status off the bot.",
];
const DUEL_BOT_LOSE = [  // bot beat the player
  "Embarrassing scenes, sunshine.",
  "Egg and cress, innit.",
  "Bot said nah.",
  "Absolute Mr X behaviour, that.",
];

const MOVES = [
  "{user} HAS the fakin moves, sunshine 🕺",
  "Oi oi — {user}'s got the muvafukin moves!",
  "{user}? Yeah... {user}'s got the moves, son. Certified.",
  "Who's got the moves? {user}'s got the fakin moves, that's who.",
  "Step aside — {user} has the moves, sunshine. The Guvnah said so. 👑",
  "{user} movin' like the General himself. Fakin moves, sunshine.",
];

const GENERAL = [
  "The G. The General. The muvafukin Guvnah. Bow down 👑",
  "Sean runs this ting — imstilldadaddy, the Guvnah, innit.",
  "Who's the Guvnah? imstilldadaddy. Always has been. 🫡",
  "G status. The General does not miss, sunshine.",
  "That's the muvafukin Guvnah to you. Show some respect 👑",
  "The General's in the building. Egg and cress merchants, look away.",
  "EU's #1 Guile. The Sonic Boom is law in this house ⚡",
  "CotW EU Road-to-EWC champion. Mai's the Guvnah's, sunshine.",
  "VSF XIII silver, SFL EU vet, EVO regular. The CV speaks 🫡",
  "Captain of the Army. The General's been buildin' this since SFV.",
  "London FGC's loudest, proudest, sharpest. The Guvnah 🇬🇧👑",
  "From the lab to the stage to your dreams. That's the General.",
];

const MRX = [
  "Mr X stream-snipes with Ken and still can't take the set.",
  "Couldn't hit a combo on Modern, never mind Classic. That's Mr X.",
  "Mr X mashes DP and calls it a read.",
  "All chat, no neutral. Mr X ducks every runback.",
  "Hardstuck since launch — snipes the stream 'cause he can't survive the actual queue.",
  "Mr X's whole gameplan: jab, DP, cry in chat.",
  "Talks big, declines the FT5 every single time.",
  "Only thing Mr X is consistent at is lagging out when he's losing.",
];

// Jimmy — another ISDD rival. The beggar. Loves egg and cress, mashes
// light-jab anti-air, certified scrub. Has his own little chant.
const JIMMY = [
  "🎵 Jimmyyy loves egg and cress, and he begs for it every daaay 🎵",
  "Jimmy you SO godlike 🙏 I wish I could press light jab anti-air just like you",
  "Jimmy? Bum. Beggar. Scrub. Next question.",
  "Jimmy mains the beg button. Egg and cress merchant of the year 🥪🏆",
  "Imagine losing to Jimmy. Couldn't be the Guvnah. Light-jab-anti-air ahh player.",
  "Jimmy beggin' for egg and cress AND a free win. Get a job, sunshine.",
  "Jimmy so 'godlike' he anti-airs with light jab and STILL eats the counter. Scrub.",
  "Oi Jimmy — the General sends his regards. Now go beg for your egg and cress 🥪👑",
];

// IbraaaTTV — Arc Raiders streamer-hunter. He gets called a hacker daily;
// the bot CLAPS BACK at the accusers (cope / skill issue / salt). It never
// says he hacks. He hunts streamers in-game (NOT stream sniping).
const IBRA = [
  "Ibra — Arc Raiders' apex predator. Hunts streamers for sport. Hated for being good.",
  "IbraaaTTV: the reason other streamers play in private lobbies.",
  "Gets called a hacker daily. Funny how it's always right after he wins.",
  "Part raider, part menace. The accusations are just the fan club.",
  "Ibra doesn't farm loot. He farms streamers — and their excuses.",
];

// Auto-fired at chatters who cry hacker/ESP/aimbot/cheating. Dunks on the
// ACCUSER (no names, no @). Harsh but ToS-clean: cope/skill/seethe only —
// no slurs, no self-harm, no threats.
const HACKS = [
  "You didn't get hacked. You got raided. Welcome to Arc Raiders.",
  "Lost your whole kit and the only thing you extracted was an excuse.",
  "He cleaned you and you ran to chat instead of the extract. Priorities.",
  "The ARC bots give you more trouble than he ever did. Sit with that.",
  "Crying hacker won't get your loot back. It's his stash now.",
  "Skill gap wider than the map. No wonder you never make extract.",
  "He's not running ESP. He just heard you loot like a washing machine.",
  "Sent back to Speranza with nothing but a conspiracy theory. Rough.",
  "You got hunted, looted and left. The 'hacker' part is pure cope.",
  "Every raid you die, every raid it's 'hacks'. Maybe it's just you.",
  "He extracted with your kit. You extracted to the chat box. Seethe.",
  "Not a cheat. He plays Arc Raiders — you just attend it.",
  "Third-partied by one guy and called it aimbot. Embarrassing scenes.",
  "Loadout gone, dignity gone, and your best excuse is 'ESP'. Tragic.",
];

const HUNT = [
  "Ibra's on the hunt — some streamer's about to load a death screen they can't explain.",
  "He's not watching your stream. He's in your lobby. Behind you. Already aiming.",
  "Another content creator about to become Ibra content.",
  "Ibra found you. Not your stream — YOU. Good luck.",
  "Somewhere a streamer just got cleaned up by Ibra and is still talking to chat.",
  "Ibra doesn't snipe streams. He hunts. There's a difference and it's worse for you.",
  "Hunt's on. If you're live and on this map, you're prey.",
];

// ---------- Duel-streak milestones ----------
// Fires exactly AT each threshold (a streak of 11 doesn't repeat the 10 line;
// a streak of 4 produces nothing). Quiet between milestones so each callout
// feels like an event, not a ping. Pure data — games.js queries by streak.
const STREAK_LINES = {
  3:   ["🔥 {name} on a 3-W streak — careful now.",
        "🔥 {name} stacking dubs. 3 in a row."],
  5:   ["🔥🔥 {name} on a 5-W tear. Check the matchmaker.",
        "🔥🔥 5 STRAIGHT for {name}. Bot's gettin' nervous."],
  10:  ["🚀 {name} — 10 STRAIGHT. The General's Army stands up 👑",
        "🚀 Ten in a row for {name}. That's not luck, that's tax."],
  20:  ["👑 {name} hits 20-W. Officially terrifying.",
        "👑 20 W STREAK — {name} on the Guvnah's radar."],
  50:  ["💀 {name} — 50 IN A ROW. Stop them. Please.",
        "💀 50-W streak. {name} breaking the bot's spirit."],
  100: ["🏛️ {name} — 100 STRAIGHT. They build statues for this.",
        "🏛️ Triple-digit streak. {name} owns the room."],
};
function duelStreak(name, streak) {
  const pool = STREAK_LINES[streak];
  if (!pool) return null;
  return pool[Math.floor(Math.random() * pool.length)].replace(/\{name\}/g, name);
}

// ===========================================================================
// Heartbeat / ambient banter pools — fired by bot.js on a jittered timer.
// Pools split by context so the line fits the room: time of day, current
// game on Twitch, chat heat (msgs/min). Lines are written in the Guvnah's
// voice — Pum Pum city, EU Guile, CotW EU champ, salt, swagger, no off-
// limits territory (no prison/family/violence references — see the brief).
// Keep each line punchy (≈ <180 chars) so Twitch reads it clean.
// ===========================================================================

// Always-applicable Guvnah-isms. Default pool; weighted heaviest.
const BANTER_GENERAL = [
  "The Guvnah's cooking. Chat stay locked in 👑",
  "Pum pum city, sunshine. Always has been.",
  "If you're lurking, you're losing. Say something.",
  "Imagine farming the General. Couldn't be Shakz, somehow.",
  "Egg and cress merchants stay quiet — the General's talkin'.",
  "Type !pp if you wanna see what the General's Army's earning today.",
  "Drop a !commands if you're new — points, bets, games, the lot.",
  "Anyone seen Jimmy? Tell him the General sends his regards 🥪",
  "Mr X is in a dark room watching VODs right now. Sad behaviour.",
  "Real ones in chat — drop a 👑 if you in the General's Army.",
  "Sub button's open if you want to officially join the Army 🫡",
  "Sonic Boom. Sonic Boom. Sonic Boom. That's the gameplan.",
  "If you mash, you crash. Patience wins, sunshine.",
  "Run it up the Army 🪖 the Guvnah's in his bag.",
  "Ain't no DP gonna save you from a read like that.",
  "Footsies fakers, prepare for tuition.",
  "Streamer's at work. Chat keep the room warm 🔥",
  "We don't play scared in this house.",
  "EU's #1 Guile is in session. Take notes.",
  "On stream we read. Off stream we lab. Either way you lose.",
  "When the Guvnah cooks, even the spectators get full.",
  "Anti-air with a button, not a prayer. Light jab is a coping mechanism.",
  "Egg and cress diet keeping Jimmy hardstuck 🥪🔒",
  "If Shakz watching — say hi 👋 we know you lurkin'.",
  "Salty Sessions Vol. 99 dropping when chat least expects it.",
  "Drink water, sit up straight, beat your mate.",
  "Half this chat could not anti-air a balloon.",
  "Free advice: stop pressing buttons.",
  "imstilldadaddy. Still. Da. Daddy. Read it back.",
  "Pum pum prices are up today. Earn while you can 💰",
  "London FGC standing up. Where my UK ones at?",
  "Master rank energy in this chat. Sustain it.",
  "Tell your mum the General is back.",
  "If you're new — !pp, !rank, !top, !commands. Then go cause problems.",
  "We grindin' for the trophy AND the chat. Two-front war 🛡️",
];

// Game-specific. Fired when Helix says he's on that game right now.
const BANTER_SF6 = [
  "Guile in SF6 is patience monetized.",
  "If you eat a Sonic Boom on wakeup, that's a you problem.",
  "Mai in SF6 = fans bouncing off your DP attempts. Smile, lose, repeat.",
  "Drive Rush into nothing. Classic Mr X behaviour.",
  "Master rank lobby is just labbing a corner reset 30 times in a row.",
  "Burnout state and a Sonic Boom incoming. Skill issue.",
  "Don't parry, don't impact, don't dream. Just block.",
  "Light jab anti-air is a hate crime against neutral.",
  "If you main Ken in 2026, the General is praying for you.",
  "Modern vs Classic — both lose to the Guvnah, sunshine.",
  "Drive Impact at neutral against the General? Funny.",
  "Counter-hit into oblivion. That's a Guile sentence.",
  "Sonic Boom every 9 frames. Read the docs, sunshine.",
  "Punish counter c.HP is the Queen's English.",
  "Cammy pick? Just play badminton, same skill ceiling.",
  "If you main Akuma in SF6 you owe the General royalty payments 👑",
  "Alex pick? Bold. Stylish. Stupid. All three.",
  "Just Frame Sonic Boom. The art form. Tell Jimmy 🥪",
  "Ed mirror? Two Guvnahs enter, one leaves. Spoiler.",
  "If you DI'd that you owe the bot an apology.",
];

const BANTER_COTW = [
  "Mai in CotW is sweepin' the legs and the league.",
  "Fatal Fury's back. So's the General. Coincidence? Couldn't be.",
  "If you slide-input on Mai you basically already won, sunshine.",
  "Mr Big out here body-checking the casuals 🦂",
  "CotW Hyper-Defense breaking opponents' wills before round 2.",
  "Rev meter management is the new bag of tricks. The Guvnah's bag is big.",
  "Chun-Li in CotW is calmly walking into your nightmares.",
  "EU Road to EWC champion already paid the bills — this is dessert.",
  "Reverse to the head, reverse to the wallet.",
  "SNK said 'be patient' — the Guvnah's been patient since 2002.",
  "CotW newcomers think DP is a defense option. Cute.",
  "Mai mirror — two patient predators. One Guvnah.",
  "Fatal Fury chat, welcome to civilization 🫡",
  "Rock pick? Hope your reads are loud.",
  "S.P.G. window incoming. Comeback merchants assemble.",
];

const BANTER_ARC = [
  "Raid the bots, raid the chat, log off rich.",
  "If you hear footsteps, that's Ibra. Sorry.",
  "Stash space, slot space, headshot space. The G has all three.",
  "Loadout gone, dignity gone, chat still here. Welcome to Speranza.",
  "Third-party me again. I dare you.",
  "Extracting with your friend's loot is the truest love language.",
  "Backpack full, conscience empty. Vibes.",
  "Dome someone, type 'gg', live forever.",
  "If you call HACKS in chat the bot will dunk on you. Try it.",
  "Day-one Raider, year-three Raider — still can't anti-air a drone.",
  "Solo queue Raiders. The room for a teammate is reserved for ego.",
  "Survival of the slickest, sunshine.",
  "ARC bots harder than half this lobby. Sit with that.",
  "He cleaned you and you ran to chat instead of extract. Priorities.",
  "Loot 'em, leave 'em, log on tomorrow. The cycle 🔁",
];

const BANTER_MK = [
  "Brutality on the brain, breakfast on the side.",
  "Mortal Kombat 1 grind. Sikander somewhere stewing 🥶",
  "Sub-Zero mirror. One brings ice, the other brings the Guvnah.",
  "Frost gap closer than your DP gap, Mr X.",
  "Kameo this, kameo that — get fataled.",
  "The Beef set never ended, it just relocated.",
  "MK1 button mashers in shambles tonight.",
  "Krushing blow → ego deletion. Healthy.",
  "Salty Runback Vol. ∞ in production.",
  "Spawn, Joker, Homelander — same outcome.",
];

// Time-of-day pools (Europe/London hour).
const BANTER_MORNING = [   // 06:00–11:59
  "Morning sunshine. Coffee, then carnage ☕",
  "Up and at 'em, General's Army. Birds chirpin', bums losin'.",
  "Early bird gets the EX Sonic Boom.",
  "Morning lab. Afternoon league. Evening therapy for the opponents.",
  "Anyone else hate mornings, or just the people in your lobbies?",
  "Caffeine intake: sufficient. Patience intake: overflowing.",
  "Good morning to everyone except Mr X.",
  "Sunrise grind. Bet the egg and cress mob still snorin' 🥪",
];

const BANTER_LATE = [      // 23:00–03:59
  "Past midnight. Only the real ones still in chat 🌙",
  "Late-night ranked is just emotional damage with a soundtrack.",
  "Sleep is a stat. The Guvnah's willing to drop it tonight.",
  "Insomnia gang reporting in 👋",
  "If you're up past 1am you owe the room a !pp check.",
  "Lobbies thinning. Salt thickening. Soup season.",
  "Witching hour. Wake the neighbours with a Flash Kick.",
  "Late-night Mai is the best Mai. Don't ask.",
  "Anyone who clocks off before the Guvnah is on probation.",
  "Pum pum city after dark, sunshine.",
  "Donate water. Donate sleep. The General accepts both.",
  "The night belongs to the ones who never blink.",
];

// Chat-heat pools (msgs/min in last window).
const BANTER_HOT = [
  "Chat is COOKIN' 🔥 keep it lit",
  "Lobby's electric. Don't ruin it with bad takes.",
  "Look at this room. Generals everywhere 👑",
  "Energy check — PASSED. Carry on.",
  "Chat going harder than the opponent rn.",
  "Mods earn double tonight, mind the egos.",
  "If you ain't typing you ain't here, sunshine.",
  "This is what they took from us in 2020 — a live chat.",
  "Chat moving faster than Mr X's excuses.",
  "PP gains looking heavy tonight. Stay loud 💰",
  "FGC Twitter could never. This room cooks.",
  "I love a chat that yaps. Yap on, lads.",
  "Pum pum city is overcrowded today 🚀",
  "100 chats since I last looked. Sheesh 👀",
];

const BANTER_COLD = [
  "Bit quiet in here. Type 1 if you alive.",
  "Lurker check 👀 say something or the bot starts inventin' facts about you.",
  "Where's everyone? The Guvnah's playing for a *crowd*.",
  "Type !pp — it'll wake you up I promise.",
  "Chat's dead. Mr X must be in here lurking.",
  "Hello? Echo? Anybody?",
  "Quiet room costs the streamer XP. Talk to him.",
  "Drop a 👑 if you in here.",
  "Slow chat. Get loud or get logged.",
  "Reminder for the lurkers — !pp, !rank, !top. Earn while you idle.",
];

// ---------- Heartbeat picker ----------
// Maps Twitch Helix game_name -> internal key. Unknown game => null,
// banter() then sticks to game-agnostic pools.
function mapGame(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  if (n.includes('street fighter 6') || n.includes('street fighter vi')) return 'SF6';
  if (n.includes('fatal fury') || n.includes('city of the wolves') || n === 'cotw') return 'COTW';
  if (n.includes('arc raiders') || n === 'arc raiders') return 'ARC';
  if (n.includes('mortal kombat')) return 'MK';
  return null;
}

// Anti-repeat memory. Keyed by line text -> last-fired timestamp. Bounded.
const recent = new Map();
const RECENT_TTL_MS = 60 * 60 * 1000;   // don't repeat within an hour
const RECENT_MAX = 200;
function markFired(text) {
  recent.set(text, Date.now());
  if (recent.size > RECENT_MAX) {
    // drop the oldest ~25%
    const sorted = [...recent.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < Math.floor(RECENT_MAX / 4); i++) recent.delete(sorted[i][0]);
  }
}
function isRecent(text) {
  const t = recent.get(text);
  return t != null && (Date.now() - t) < RECENT_TTL_MS;
}

// Weighted random across N pools, then a non-recent pick from the chosen one.
// Falls back: if every line in the chosen pool is "recent", try once more
// from GENERAL; if still nothing fresh, just return any line — bot will not
// stall on a tiny pool.
function pickFromPools(pools) {
  const total = pools.reduce((s, p) => s + p.w, 0);
  let r = Math.random() * total;
  let chosen = pools[0].pool;
  for (const p of pools) {
    r -= p.w;
    if (r <= 0) { chosen = p.pool; break; }
  }
  const fresh = chosen.filter(l => !isRecent(l));
  if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
  const fb = BANTER_GENERAL.filter(l => !isRecent(l));
  if (fb.length) return fb[Math.floor(Math.random() * fb.length)];
  return chosen[Math.floor(Math.random() * chosen.length)];
}

/**
 * Pick an ambient-banter line for the current context.
 *  ctx.game  – Twitch game_name string OR mapped key ('SF6'|'COTW'|'ARC'|'MK')
 *  ctx.hour  – 0..23 (Europe/London). Defaults to local hour.
 *  ctx.heat  – 'hot' | 'cold' | undefined
 * Records the chosen line so it isn't repeated within RECENT_TTL_MS.
 */
function banter(ctx = {}) {
  const gameKey = ctx.game && ctx.game.length <= 5 ? ctx.game : mapGame(ctx.game);
  const hour = (typeof ctx.hour === 'number') ? ctx.hour : new Date().getHours();
  const heat = ctx.heat;

  const pools = [{ pool: BANTER_GENERAL, w: 8 }];
  if (heat === 'hot') pools.push({ pool: BANTER_HOT, w: 6 });
  if (heat === 'cold') pools.push({ pool: BANTER_COLD, w: 6 });
  if (gameKey === 'SF6')  pools.push({ pool: BANTER_SF6,  w: 5 });
  if (gameKey === 'COTW') pools.push({ pool: BANTER_COTW, w: 5 });
  if (gameKey === 'ARC')  pools.push({ pool: BANTER_ARC,  w: 5 });
  if (gameKey === 'MK')   pools.push({ pool: BANTER_MK,   w: 5 });
  if (hour >= 6 && hour < 12) pools.push({ pool: BANTER_MORNING, w: 3 });
  if (hour >= 23 || hour < 4) pools.push({ pool: BANTER_LATE,    w: 4 });

  const chosen = pickFromPools(pools);
  markFired(chosen);
  return chosen;
}

module.exports = {
  duelHumanWin: (v) => line(DUEL_WIN, v),
  duelBotWin:   (v) => line(DUEL_BOT_WIN, v),
  duelBotLose:  (v) => line(DUEL_BOT_LOSE, v),
  moves:        (v) => line(MOVES, v),
  general:      ()  => line(GENERAL, {}),
  mrx:          ()  => line(MRX, {}),
  jimmy:        ()  => line(JIMMY, {}),
  clash:        ()  => line(CLASH, {}),
  ibra:         ()  => line(IBRA, {}),
  hacks:        ()  => line(HACKS, {}),
  hunt:         ()  => line(HUNT, {}),
  duelStreak,
  banter,
  mapGame,
};
