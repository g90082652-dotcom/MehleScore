const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");

const app = express();

app.set("trust proxy", 1);

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing");
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  console.error("ERROR: ADMIN_PASSWORD is missing");
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error("ERROR: JWT_SECRET is missing");
  process.exit(1);
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================================================
   VAPID / PUSH
========================================================= */

const VAPID_PUBLIC_KEY = String(
  process.env.VAPID_PUBLIC_KEY || ""
).trim();

const VAPID_PRIVATE_KEY = String(
  process.env.VAPID_PRIVATE_KEY || ""
).trim();

let VAPID_SUBJECT = String(
  process.env.VAPID_EMAIL ||
  process.env.VAPID_SUBJECT ||
  ""
).trim();

if (
  VAPID_SUBJECT &&
  !VAPID_SUBJECT.startsWith("mailto:") &&
  !VAPID_SUBJECT.startsWith("http://") &&
  !VAPID_SUBJECT.startsWith("https://")
) {
  VAPID_SUBJECT = `mailto:${VAPID_SUBJECT}`;
}

if (!VAPID_SUBJECT) {
  VAPID_SUBJECT = "mailto:aliscore@example.com";
}

let pushEnabled = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

    pushEnabled = true;

    console.log("Web Push: enabled");
    console.log("VAPID subject:", VAPID_SUBJECT);
  } catch (err) {
    pushEnabled = false;

    console.error(
      "Web Push configuration error:",
      err.message
    );
  }
} else {
  console.log(
    "Web Push: disabled - VAPID keys missing"
  );
}

/* =========================================================
   HELPERS
========================================================= */

function cleanString(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}

function intValue(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.trunc(n);
}

function nullableInt(value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "null"
  ) {
    return null;
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.trunc(n);
}

function numberValue(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

async function query(text, params = []) {
  return pool.query(text, params);
}

function eventStatColumn(type) {
  const map = {
    goal: "goals",
    assist: "assists",
    save: "saves",
    yellow: "yellow_cards",
    red: "red_cards"
  };

  return map[type] || null;
}

async function createNotification(
  type,
  title,
  body,
  data = {}
) {
  try {
    await query(
      `
        INSERT INTO notifications
          (type, title, body, data)
        VALUES
          ($1, $2, $3, $4)
      `,
      [
        type,
        title,
        body,
        JSON.stringify(data || {})
      ]
    );
  } catch (err) {
    console.error(
      "Notification create error:",
      err.message
    );
  }
}

async function sendPush(
  title,
  body,
  data = {}
) {
  if (!pushEnabled) {
    return;
  }

  let subscriptions;

  try {
    const result = await query(`
      SELECT
        id,
        endpoint,
        p256dh,
        auth
      FROM push_subscriptions
    `);

    subscriptions = result.rows;
  } catch (err) {
    console.error(
      "Push subscriptions read error:",
      err.message
    );

    return;
  }

  const payload = JSON.stringify({
    title,
    body,
    data
  });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        },
        payload
      );
    } catch (err) {
      console.error(
        "Push send error:",
        err.statusCode || "",
        err.message
      );

      if (
        err.statusCode === 404 ||
        err.statusCode === 410
      ) {
        try {
          await query(
            `
              DELETE FROM push_subscriptions
              WHERE id = $1
            `,
            [sub.id]
          );
        } catch (deleteErr) {
          console.error(
            "Old push subscription delete error:",
            deleteErr.message
          );
        }
      }
    }
  }
}

async function notify(
  type,
  title,
  body,
  data = {}
) {
  await createNotification(
    type,
    title,
    body,
    data
  );

  await sendPush(
    title,
    body,
    data
  );
}

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      logo TEXT DEFAULT '',
      captain TEXT DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      goals_for INTEGER NOT NULL DEFAULT 0,
      goals_against INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      number INTEGER DEFAULT 0,
      position TEXT DEFAULT '',
      photo TEXT DEFAULT '',
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      yellow_cards INTEGER NOT NULL DEFAULT 0,
      red_cards INTEGER NOT NULL DEFAULT 0,
      rating NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      home_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      away_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      home_score INTEGER NOT NULL DEFAULT 0,
      away_score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled',
      match_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      venue TEXT DEFAULT '',
      player_of_match_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS match_events (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      minute INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      type TEXT DEFAULT '',
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS team_of_week (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      goalkeeper_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      defender_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      midfielder_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      attacker_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS team_of_week_players (
      id SERIAL PRIMARY KEY,
      team_of_week_id INTEGER NOT NULL REFERENCES team_of_week(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      position TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS lineup_players (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      position TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS lineups (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      goalkeeper_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      defenders JSONB DEFAULT '[]'::jsonb,
      midfielders JSONB DEFAULT '[]'::jsonb,
      attackers JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      from_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      to_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      transfer_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration for existing AliScore databases created before transfer fees.
  await query(`
    ALTER TABLE transfers
    ADD COLUMN IF NOT EXISTS transfer_fee NUMERIC(14,2) NOT NULL DEFAULT 0
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* =======================================================
     GOAL OF THE WEEK VOTING
  ======================================================= */

  await query(`
    CREATE TABLE IF NOT EXISTS goal_of_week_polls (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Həftənin qolu',
      week TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS goal_of_week_candidates (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES goal_of_week_polls(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
      video_url TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS goal_of_week_votes (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES goal_of_week_polls(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES goal_of_week_candidates(id) ON DELETE CASCADE,
      voter_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (poll_id, voter_id)
    )
  `);

  /* =======================================================
     TEAMS COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS logo TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS captain TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS played INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS draws INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS losses INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS goals_for INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS goals_against INTEGER NOT NULL DEFAULT 0
  `);

  /* =======================================================
     PLAYERS COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS team_id INTEGER
  `);

  try {
    await query(`
      ALTER TABLE players
      ADD CONSTRAINT players_team_id_fkey
      FOREIGN KEY (team_id)
      REFERENCES teams(id)
      ON DELETE SET NULL
    `);
  } catch (err) {
    if (
      !String(err.message || "")
        .toLowerCase()
        .includes("already exists")
    ) {
      console.log(
        "players_team_id_fkey:",
        err.message
      );
    }
  }

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS number INTEGER DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS position TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS goals INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS assists INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS saves INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS yellow_cards INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS red_cards INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0
  `);

  try {
    await query(`
      ALTER TABLE players
      ALTER COLUMN rating TYPE NUMERIC
      USING COALESCE(rating, 0)::NUMERIC
    `);
  } catch (err) {
    console.log(
      "Rating type compatibility:",
      err.message
    );
  }

  /* =======================================================
     MATCHES COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled'
  `);

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS match_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS venue TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS player_of_match_id INTEGER
  `);

  try {
    await query(`
      ALTER TABLE matches
      ADD CONSTRAINT matches_player_of_match_fk
      FOREIGN KEY (player_of_match_id)
      REFERENCES players(id)
      ON DELETE SET NULL
    `);
  } catch (err) {
    if (!String(err.message || "").includes("already exists")) {
      console.log("Player of match FK compatibility:", err.message);
    }
  }

  /* =======================================================
     TEAM OF THE WEEK COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS week TEXT
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS goalkeeper_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS defender_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS midfielder_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS attacker_id INTEGER
  `);

  // Older AliScore databases may have team_of_week without created_at.
  // The API sorts the latest Team of the Week by this column, so make sure
  // the column exists before any /api/state or /api/team-of-week request.
  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  await query(`
    ALTER TABLE team_of_week_players
    ADD COLUMN IF NOT EXISTS team_of_week_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week_players
    ADD COLUMN IF NOT EXISTS player_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week_players
    ADD COLUMN IF NOT EXISTS position TEXT DEFAULT ''
  `);

  /* =======================================================
     EVENTS COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS team_id INTEGER
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS player_id INTEGER
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS type TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS minute INTEGER DEFAULT 0
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''
  `);

  /* =======================================================
     HALL OF FAME / SEASON ARCHIVE
  ======================================================= */

  await query(`
    CREATE TABLE IF NOT EXISTS season_player_stats (
      id SERIAL PRIMARY KEY,
      season TEXT NOT NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      player_name TEXT NOT NULL,
      team_name TEXT DEFAULT '',
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      yellow_cards INTEGER NOT NULL DEFAULT 0,
      red_cards INTEGER NOT NULL DEFAULT 0,
      mvp INTEGER NOT NULL DEFAULT 0,
      photo TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (season, player_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS season_archives (
      id SERIAL PRIMARY KEY,
      season TEXT NOT NULL UNIQUE,
      archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await seedData();

  console.log("Database initialized");
}

/* =========================================================
   SEED
========================================================= */

async function seedData() {
  const teams = [
    "Xirdalan United",
    "Xirdalan Wolves",
    "Neweli FK",
    "MSN FK",
    "Lotu pişiklər"
  ];

  for (const name of teams) {
    await query(
      `
        INSERT INTO teams (name)
        VALUES ($1)
        ON CONFLICT (name) DO NOTHING
      `,
      [name]
    );
  }

  const teamRows = await query(
    `
      SELECT id, name
      FROM teams
      WHERE name = ANY($1)
    `,
    [teams]
  );

  const teamMap = {};

  for (const row of teamRows.rows) {
    teamMap[row.name] = row.id;
  }

  const captains = {
    "Xirdalan United": "Amil",
    "Xirdalan Wolves": "Ali",
    "Lotu pişiklər": "Kamran",
    "MSN FK": "Fuad",
    "Neweli FK": "Tofik"
  };

  for (const [teamName, captain] of Object.entries(captains)) {
    const teamId = teamMap[teamName];
    if (teamId) {
      await query(
        `UPDATE teams SET captain = $1 WHERE id = $2`,
        [captain, teamId]
      );
    }
  }

  const seedPlayers = [
    ["Xirdalan Wolves", "Ali", 1, "Qapıçı"],
    ["Xirdalan Wolves", "Emin", 2, "Müdafiə"],
    ["Xirdalan Wolves", "Huseyin", 3, "Müdafiə"],
    ["Xirdalan Wolves", "Raul", 4, "Hücum"],

    ["Xirdalan United", "Amil", 1, "Qapıçı"],
    ["Xirdalan United", "Elmir", 2, "Müdafiə"],
    ["Xirdalan United", "İsa", 3, "Yarımmüdafiə"],
    ["Xirdalan United", "Ümüd", 4, "Hücum"],
    ["Xirdalan United", "Huseyin", 5, "Müdafiə"],

    ["MSN FK", "Fuad", 1, "Qapıçı"],
    ["MSN FK", "Murad", 2, "Müdafiə"],

    ["Neweli FK", "Tofik", 1, "Qapıçı"],
    ["Neweli FK", "Arda", 2, "Müdafiə"],
    ["Neweli FK", "Veli", 3, "Yarımmüdafiə"],
    ["Neweli FK", "Emil", 4, "Hücum"],

    ["Lotu pişiklər", "Kamran", 1, "Qapıçı"],
    ["Lotu pişiklər", "Ayxan", 2, "Müdafiə"],
    ["Lotu pişiklər", "Ramil", 3, "Hücum"]
  ];

  for (const item of seedPlayers) {
    const teamName = item[0];
    const playerName = item[1];
    const number = item[2];
    const position = item[3];

    const teamId = teamMap[teamName];

    if (!teamId) continue;

    const exists = await query(
      `
        SELECT id
        FROM players
        WHERE team_id = $1
          AND LOWER(name) = LOWER($2)
        LIMIT 1
      `,
      [teamId, playerName]
    );

    if (!exists.rows.length) {
      await query(
        `
          INSERT INTO players
            (
              team_id,
              name,
              number,
              position
            )
          VALUES
            ($1, $2, $3, $4)
        `,
        [
          teamId,
          playerName,
          number,
          position
        ]
      );
    }
  }
}


/* =========================================================
   BASIC
========================================================= */

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");

    res.json({
      ok: true,
      database: "connected"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      database: "error",
      error: err.message
    });
  }
});

app.get("/api", async (req, res) => {
  try {
    await query("SELECT 1");

    res.json({
      ok: true,
      api: "AliScore API",
      database: "connected",
      push: pushEnabled
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      api: "AliScore API",
      database: "error",
      error: err.message
    });
  }
});


/* =========================================================
   HALL OF FAME / SEASON MANAGEMENT
========================================================= */

function hallSeasonForDate(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  return m >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function previousSeasonForDate(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  return m >= 6 ? `${y - 1}-${y}` : `${y - 2}-${y - 1}`;
}

async function archiveSeason(season) {
  if (!season) return { archived: false, reason: "no-season" };

  const exists = await query(
    `SELECT id FROM season_archives WHERE season = $1 LIMIT 1`,
    [season]
  );
  if (exists.rows.length) {
    return { archived: false, reason: "already-archived", season };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const playersResult = await client.query(`
      SELECT
        p.id,
        p.name,
        COALESCE(t.name, '') AS team_name,
        COALESCE(p.goals,0) AS goals,
        COALESCE(p.assists,0) AS assists,
        COALESCE(p.saves,0) AS saves,
        COALESCE(p.yellow_cards,0) AS yellow_cards,
        COALESCE(p.red_cards,0) AS red_cards,
        COALESCE(p.photo,'') AS photo,
        (
          SELECT COUNT(*)
          FROM matches m
          WHERE m.player_of_match_id = p.id
        ) AS mvp
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
    `);

    for (const p of playersResult.rows) {
      await client.query(`
        INSERT INTO season_player_stats
          (season, player_id, player_name, team_name, goals, assists, saves,
           yellow_cards, red_cards, mvp, photo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (season, player_id) DO NOTHING
      `, [
        season, p.id, p.name, p.team_name,
        Number(p.goals)||0, Number(p.assists)||0, Number(p.saves)||0,
        Number(p.yellow_cards)||0, Number(p.red_cards)||0,
        Number(p.mvp)||0, p.photo || ""
      ]);
    }

    await client.query(
      `INSERT INTO season_archives (season) VALUES ($1)`,
      [season]
    );

    // Start the new season with clean player and table statistics.
    await client.query(`
      UPDATE players
      SET goals=0, assists=0, saves=0, yellow_cards=0, red_cards=0, rating=0
    `);

    await client.query(`
      UPDATE teams
      SET points=0, played=0, wins=0, draws=0, losses=0,
          goals_for=0, goals_against=0
    `);

    await client.query("COMMIT");
    console.log(`[Hall of Fame] Season ${season} archived and new season started.`);
    try {
      await createNotification(
        "hall_of_fame",
        "🏆 Hall of Fame",
        `🏆 ${season} mövsümü başa çatdı. Hall of Fame yaradıldı və yeni mövsüm başladı.`,
        { season }
      );
    } catch (e) {
      console.log("Hall notification:", e.message);
    }
    return { archived: true, season };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function checkSeasonRollover() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  // May 31: archive the season automatically. Running the check on startup
  // also catches a deployment/server restart that happened on May 31.
  if (month === 5 && day >= 31) {
    await archiveSeason(previousSeasonForDate(now));
  }
  // If the server was offline on May 31, archive the missed previous season
  // on any date from June 1 until the next May 30.
  else if (month >= 6) {
    await archiveSeason(previousSeasonForDate(now));
  }
}

async function getHallOfFame(season) {
  const target = season || previousSeasonForDate(new Date());
  const result = await query(`
    SELECT *
    FROM season_player_stats
    WHERE season = $1
    ORDER BY player_name ASC
  `, [target]);

  const rows = result.rows.map(x => ({
    ...x,
    goals: Number(x.goals)||0,
    assists: Number(x.assists)||0,
    saves: Number(x.saves)||0,
    yellow_cards: Number(x.yellow_cards)||0,
    red_cards: Number(x.red_cards)||0,
    mvp: Number(x.mvp)||0
  }));

  const top = field => rows.slice().sort((a,b) => b[field]-a[field] || a.player_name.localeCompare(b.player_name));
  return {
    season: target,
    archived: rows.length > 0,
    records: {
      goals: top("goals").slice(0, 5),
      assists: top("assists").slice(0, 5),
      saves: top("saves").slice(0, 5),
      mvp: top("mvp").slice(0, 5),
      yellow_cards: top("yellow_cards").slice(0, 5),
      red_cards: top("red_cards").slice(0, 5)
    },
    players: rows
  };
}

/* =========================================================
   STATE
========================================================= */

app.get("/api/state", async (req, res) => {
  try {
    const [
      teams,
      players,
      matches,
      events,
      notifications,
      transfers,
      teamOfWeek
    ] = await Promise.all([
      query(`
        SELECT
          t.*,
          (
            t.goals_for -
            t.goals_against
          ) AS goal_difference
        FROM teams t
        ORDER BY
          t.points DESC,
          (
            t.goals_for -
            t.goals_against
          ) DESC,
          t.goals_for DESC,
          t.name ASC
      `),

      query(`
        SELECT
          p.*,
          t.name AS team_name
        FROM players p
        LEFT JOIN teams t
          ON t.id = p.team_id
        ORDER BY
          t.name ASC,
          p.number ASC,
          p.name ASC
      `),

      query(`
        SELECT
          m.*,
          ht.name AS home_team_name,
          ht.logo AS home_team_logo,
          at.name AS away_team_name,
          at.logo AS away_team_logo
        FROM matches m
        LEFT JOIN teams ht
          ON ht.id = m.home_team_id
        LEFT JOIN teams at
          ON at.id = m.away_team_id
        ORDER BY
          m.match_date DESC,
          m.id DESC
      `),

      query(`
        SELECT
          e.*,
          p.name AS player_name,
          p.photo AS player_photo,
          t.name AS team_name
        FROM match_events e
        LEFT JOIN players p
          ON p.id = e.player_id
        LEFT JOIN teams t
          ON t.id = e.team_id
        ORDER BY
          e.created_at DESC,
          e.id DESC
      `),

      query(`
        SELECT *
        FROM notifications
        ORDER BY
          created_at DESC,
          id DESC
        LIMIT 100
      `),

      query(`
        SELECT
          tr.*,
          p.name AS player_name,
          ft.name AS from_team_name,
          tt.name AS to_team_name
        FROM transfers tr
        LEFT JOIN players p
          ON p.id = tr.player_id
        LEFT JOIN teams ft
          ON ft.id = tr.from_team_id
        LEFT JOIN teams tt
          ON tt.id = tr.to_team_id
        ORDER BY
          tr.created_at DESC,
          tr.id DESC
        LIMIT 100
      `),

      query(`
        SELECT
          tw.*,
          gp.name AS goalkeeper_name,
          dp.name AS defender_name,
          mp.name AS midfielder_name,
          ap.name AS attacker_name
        FROM team_of_week tw
        LEFT JOIN players gp
          ON gp.id = tw.goalkeeper_id
        LEFT JOIN players dp
          ON dp.id = tw.defender_id
        LEFT JOIN players mp
          ON mp.id = tw.midfielder_id
        LEFT JOIN players ap
          ON ap.id = tw.attacker_id
        ORDER BY
          tw.created_at DESC,
          tw.id DESC
      `)
    ]);

    res.json({
      ok: true,
      teams: teams.rows,
      players: players.rows,
      matches: matches.rows,
      events: events.rows,
      notifications: notifications.rows,
      transfers: transfers.rows,
      teamOfWeek: teamOfWeek.rows,
      push: {
        enabled: pushEnabled,
        publicKey: VAPID_PUBLIC_KEY || ""
      }
    });
  } catch (err) {
    console.error("State error:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* =========================================================
   ADMIN AUTH — FIXED
========================================================= */

function signAdminToken() {
  return jwt.sign(
    {
      role: "admin",
      admin: true
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

function getAdminToken(req) {
  // 1. Cookie
  if (
    req.cookies &&
    req.cookies.aliscore_admin
  ) {
    return req.cookies.aliscore_admin;
  }

  // 2. Authorization Bearer
  const auth =
    req.headers.authorization || "";

  if (
    auth &&
    auth.startsWith("Bearer ")
  ) {
    return auth
      .slice(7)
      .trim();
  }

  return null;
}

function verifyAdminToken(token) {
  if (!token) {
    return null;
  }

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    if (
      !decoded ||
      decoded.role !== "admin"
    ) {
      return null;
    }

    return decoded;
  } catch (err) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const token =
    getAdminToken(req);

  const decoded =
    verifyAdminToken(token);

  if (!decoded) {
    return res.status(401).json({
      ok: false,
      error: "Admin Login required",
      code: "ADMIN_REQUIRED"
    });
  }

  req.admin = decoded;
  req.adminToken = token;

  next();
}

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const password =
        req.body &&
        req.body.password !== undefined
          ? String(
              req.body.password
            )
          : "";

      const correctPassword =
        String(
          ADMIN_PASSWORD
        );

      if (
        password !==
        correctPassword
      ) {
        return res.status(401).json({
          ok: false,
          error: "Yanlış şifrə"
        });
      }

      const token =
        signAdminToken();

      /*
        Cookie üçün Render / HTTPS
        uyğun konfiqurasiya.
      */
      res.cookie(
        "aliscore_admin",
        token,
        {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge:
            7 *
            24 *
            60 *
            60 *
            1000
        }
      );

      console.log(
        "ADMIN LOGIN: success"
      );

      res.json({
        ok: true,
        admin: true,
        token
      });
    } catch (err) {
      console.error(
        "ADMIN LOGIN ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error:
          "Admin login error"
      });
    }
  }
);

/* =========================================================
   ADMIN ME
========================================================= */

app.get(
  "/api/admin/me",
  (req, res) => {
    const token =
      getAdminToken(req);

    const decoded =
      verifyAdminToken(token);

    if (!decoded) {
      return res.json({
        ok: true,
        admin: false
      });
    }

    res.json({
      ok: true,
      admin: true,
      role: "admin"
    });
  }
);

/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/api/admin/logout",
  (req, res) => {
    res.clearCookie(
      "aliscore_admin",
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/"
      }
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   TEAMS
========================================================= */

app.get("/api/teams", async (req, res) => {
  try {
    const result = await query(`
      SELECT
        t.*,
        (
          t.goals_for -
          t.goals_against
        ) AS goal_difference
      FROM teams t
      ORDER BY
        t.points DESC,
        (
          t.goals_for -
          t.goals_against
        ) DESC,
        t.goals_for DESC,
        t.name ASC
    `);

    res.json({
      ok: true,
      teams: result.rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post(
  "/api/teams",
  requireAdmin,
  async (req, res) => {
    try {
      const name =
        cleanString(req.body.name);

      const logo =
        cleanString(req.body.logo);

      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "Komanda adı tələb olunur"
        });
      }

      const result = await query(
        `
          INSERT INTO teams
            (name, logo, captain)
          VALUES
            ($1, $2, $3)
          RETURNING *
        `,
        [name, logo, cleanString(req.body.captain)]
      );

      res.json({
        ok: true,
        team: result.rows[0]
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

async function updateTeam(req, res) {
  try {
    const id =
      intValue(req.params.id);

    const current =
      await query(
        `
          SELECT *
          FROM teams
          WHERE id = $1
        `,
        [id]
      );

    if (!current.rows.length) {
      return res.status(404).json({
        ok: false,
        error:
          "Komanda tapılmadı"
      });
    }

    const old =
      current.rows[0];

    const name =
      req.body.name !== undefined
        ? cleanString(req.body.name)
        : old.name;

    const logo =
      req.body.logo !== undefined
        ? cleanString(req.body.logo)
        : old.logo;

    const captain =
      req.body.captain !== undefined
        ? cleanString(req.body.captain)
        : old.captain || "";

    const points =
      req.body.points !== undefined
        ? intValue(req.body.points)
        : old.points;

    const played =
      req.body.played !== undefined
        ? intValue(req.body.played)
        : old.played;

    const wins =
      req.body.wins !== undefined
        ? intValue(req.body.wins)
        : old.wins;

    const draws =
      req.body.draws !== undefined
        ? intValue(req.body.draws)
        : old.draws;

    const losses =
      req.body.losses !== undefined
        ? intValue(req.body.losses)
        : old.losses;

    const goalsFor =
      req.body.goals_for !== undefined
        ? intValue(req.body.goals_for)
        : old.goals_for;

    const goalsAgainst =
      req.body.goals_against !== undefined
        ? intValue(req.body.goals_against)
        : old.goals_against;

    const result =
      await query(
        `
          UPDATE teams
          SET
            name = $1,
            logo = $2,
            captain = $3,
            points = $4,
            played = $5,
            wins = $6,
            draws = $7,
            losses = $8,
            goals_for = $9,
            goals_against = $10
          WHERE id = $11
          RETURNING *
        `,
        [
          name,
          logo,
          captain,
          points,
          played,
          wins,
          draws,
          losses,
          goalsFor,
          goalsAgainst,
          id
        ]
      );

    res.json({
      ok: true,
      team: result.rows[0]
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err.message
    });
  }
}

app.put(
  "/api/teams/:id",
  requireAdmin,
  updateTeam
);

app.patch(
  "/api/teams/:id",
  requireAdmin,
  updateTeam
);

app.delete(
  "/api/teams/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(req.params.id);

      await query(
        `
          DELETE FROM teams
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   PLAYERS
========================================================= */

app.get(
  "/api/players",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            p.*,
            t.name AS team_name,
            t.logo AS team_logo
          FROM players p
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            t.name ASC,
            p.number ASC,
            p.name ASC
        `);

      res.json({
        ok: true,
        players: result.rows
      });
    } catch (err) {
      console.error(
        "GET PLAYERS ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/players",
  requireAdmin,
  async (req, res) => {
    try {
      const teamId =
        nullableInt(
          req.body.team_id !== undefined
            ? req.body.team_id
            : req.body.teamId
        );

      const name =
        cleanString(
          req.body.name
        );

      const number =
        intValue(
          req.body.number !== undefined
            ? req.body.number
            : req.body.player_number
        );

      const rawPosition =
        req.body.position !== undefined
          ? req.body.position
          : req.body.player_position !== undefined
            ? req.body.player_position
            : req.body.role;

      const position =
        cleanString(rawPosition);

      const photo =
        cleanString(
          req.body.photo
        );

      const rating =
        req.body.rating !== undefined && req.body.rating !== ""
          ? numberValue(req.body.rating, 0)
          : 0;

      if (!Number.isFinite(rating)) {
        return res.status(400).json({
          ok: false,
          error: "Rating düzgün deyil"
        });
      }

      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "Oyunçu adı tələb olunur"
        });
      }

      if (teamId !== null) {
        const team =
          await query(
            `
              SELECT id
              FROM teams
              WHERE id = $1
            `,
            [teamId]
          );

        if (!team.rows.length) {
          return res.status(400).json({
            ok: false,
            error:
              "Komanda tapılmadı"
          });
        }
      }

      const result =
        await query(
          `
            INSERT INTO players
              (
                team_id,
                name,
                number,
                position,
                photo,
                rating
              )
            VALUES
              ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            teamId,
            name,
            number,
            position,
            photo
          ]
        );

      res.status(201).json({
        ok: true,
        player:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        "ADD PLAYER ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Oyunçu əlavə edilmədi"
      });
    }
  }
);

/* =========================================================
   UPDATE PLAYER
========================================================= */

async function updatePlayer(
  req,
  res
) {
  try {
    const id =
      intValue(req.params.id);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error:
          "Yanlış oyunçu ID-si"
      });
    }

    const current =
      await query(
        `
          SELECT *
          FROM players
          WHERE id = $1
        `,
        [id]
      );

    if (!current.rows.length) {
      return res.status(404).json({
        ok: false,
        error:
          "Oyunçu tapılmadı"
      });
    }

    const old =
      current.rows[0];

    const teamId =
      req.body.team_id !== undefined
        ? nullableInt(req.body.team_id)
        : req.body.teamId !== undefined
          ? nullableInt(req.body.teamId)
          : old.team_id;

    const name =
      req.body.name !== undefined
        ? cleanString(req.body.name)
        : old.name;

    const number =
      req.body.number !== undefined
        ? intValue(req.body.number)
        : req.body.player_number !== undefined
          ? intValue(req.body.player_number)
          : old.number;

    const rawPosition =
      req.body.position !== undefined
        ? req.body.position
        : req.body.player_position !== undefined
          ? req.body.player_position
          : req.body.role;

    const position =
      rawPosition !== undefined
        ? cleanString(rawPosition)
        : old.position;

    const photo =
      req.body.photo !== undefined
        ? cleanString(req.body.photo)
        : old.photo;

    const goals =
      req.body.goals !== undefined
        ? intValue(req.body.goals)
        : old.goals;

    const assists =
      req.body.assists !== undefined
        ? intValue(req.body.assists)
        : old.assists;

    const saves =
      req.body.saves !== undefined
        ? intValue(req.body.saves)
        : old.saves;

    const yellowCards =
      req.body.yellow_cards !== undefined
        ? intValue(req.body.yellow_cards)
        : old.yellow_cards;

    const redCards =
      req.body.red_cards !== undefined
        ? intValue(req.body.red_cards)
        : old.red_cards;

    let rating =
      old.rating !== null &&
      old.rating !== undefined
        ? Number(old.rating)
        : 0;

    if (
      req.body.rating !==
      undefined
    ) {
      const parsedRating =
        Number(req.body.rating);

      if (
        !Number.isFinite(
          parsedRating
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Rating düzgün deyil"
        });
      }

      rating = parsedRating;
    }

    if (!Number.isFinite(rating)) {
      rating = 0;
    }

    if (teamId !== null) {
      const team =
        await query(
          `
            SELECT id
            FROM teams
            WHERE id = $1
          `,
          [teamId]
        );

      if (!team.rows.length) {
        return res.status(400).json({
          ok: false,
          error:
            "Komanda tapılmadı"
        });
      }
    }

    const result =
      await query(
        `
          UPDATE players
          SET
            team_id = $1,
            name = $2,
            number = $3,
            position = $4,
            photo = $5,
            goals = $6,
            assists = $7,
            saves = $8,
            yellow_cards = $9,
            red_cards = $10,
            rating = $11
          WHERE id = $12
          RETURNING *
        `,
        [
          teamId,
          name,
          number,
          position,
          photo,
          goals,
          assists,
          saves,
          yellowCards,
          redCards,
          rating,
          id
        ]
      );

    res.json({
      ok: true,
      player:
        result.rows[0]
    });
  } catch (err) {
    console.error(
      "UPDATE PLAYER ERROR:",
      err
    );

    res.status(400).json({
      ok: false,
      error:
        err.message ||
        "Oyunçu yadda saxlanmadı"
    });
  }
}

app.put(
  "/api/players/:id",
  requireAdmin,
  updatePlayer
);

app.patch(
  "/api/players/:id",
  requireAdmin,
  updatePlayer
);

app.delete(
  "/api/players/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(req.params.id);

      if (!id) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış oyunçu ID-si"
        });
      }

      await query(
        `
          DELETE FROM players
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "DELETE PLAYER ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   MATCHES
========================================================= */

app.get(
  "/api/matches",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            m.*,
            ht.name AS home_team_name,
            ht.logo AS home_team_logo,
            at.name AS away_team_name,
            at.logo AS away_team_logo
          FROM matches m
          LEFT JOIN teams ht
            ON ht.id = m.home_team_id
          LEFT JOIN teams at
            ON at.id = m.away_team_id
          ORDER BY
            m.match_date DESC,
            m.id DESC
        `);

      res.json({
        ok: true,
        matches:
          result.rows
      });
    } catch (err) {
      console.error(
        "GET MATCHES ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/matches",
  requireAdmin,
  async (req, res) => {
    try {
      const homeTeamId =
        nullableInt(
          req.body.home_team_id !== undefined
            ? req.body.home_team_id
            : req.body.homeTeamId
        );

      const awayTeamId =
        nullableInt(
          req.body.away_team_id !== undefined
            ? req.body.away_team_id
            : req.body.awayTeamId
        );

      const homeScore =
        intValue(
          req.body.home_score !== undefined
            ? req.body.home_score
            : req.body.homeScore
        );

      const awayScore =
        intValue(
          req.body.away_score !== undefined
            ? req.body.away_score
            : req.body.awayScore
        );

      const status =
        cleanString(
          req.body.status
        ) || "scheduled";

      const matchDate =
        req.body.match_date ||
        req.body.matchDate ||
        new Date().toISOString();

      const venue =
        cleanString(
          req.body.venue
        );

      const playerOfMatchId =
        nullableInt(req.body.player_of_match_id);

      if (
        !homeTeamId ||
        !awayTeamId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "İki komanda seçilməlidir"
        });
      }

      if (
        homeTeamId ===
        awayTeamId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Eyni komanda ilə matç yaratmaq olmaz"
        });
      }

      const teams =
        await query(
          `
            SELECT id
            FROM teams
            WHERE id = ANY($1)
          `,
          [[
            homeTeamId,
            awayTeamId
          ]]
        );

      if (
        teams.rows.length !== 2
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Seçilmiş komandalar tapılmadı"
        });
      }

      const result =
        await query(
          `
            INSERT INTO matches
              (
                home_team_id,
                away_team_id,
                home_score,
                away_score,
                status,
                match_date,
                venue
              )
            VALUES
              ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `,
          [
            homeTeamId,
            awayTeamId,
            homeScore,
            awayScore,
            status,
            matchDate,
            venue
          ]
        );

      res.status(201).json({
        ok: true,
        match:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        "ADD MATCH ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Matç əlavə edilmədi"
      });
    }
  }
);

async function updateMatch(
  req,
  res
) {
  try {
    const id =
      intValue(req.params.id);

    const current =
      await query(
        `
          SELECT *
          FROM matches
          WHERE id = $1
        `,
        [id]
      );

    if (!current.rows.length) {
      return res.status(404).json({
        ok: false,
        error:
          "Matç tapılmadı"
      });
    }

    const old =
      current.rows[0];

    const homeTeamId =
      req.body.home_team_id !== undefined
        ? nullableInt(req.body.home_team_id)
        : old.home_team_id;

    const awayTeamId =
      req.body.away_team_id !== undefined
        ? nullableInt(req.body.away_team_id)
        : old.away_team_id;

    const homeScore =
      req.body.home_score !== undefined
        ? intValue(req.body.home_score)
        : old.home_score;

    const awayScore =
      req.body.away_score !== undefined
        ? intValue(req.body.away_score)
        : old.away_score;

    const status =
      req.body.status !== undefined
        ? cleanString(req.body.status)
        : old.status;

    const matchDate =
      req.body.match_date !== undefined
        ? req.body.match_date
        : old.match_date;

    const venue =
      req.body.venue !== undefined
        ? cleanString(req.body.venue)
        : old.venue;

    const playerOfMatchId =
      req.body.player_of_match_id !== undefined
        ? nullableInt(req.body.player_of_match_id)
        : old.player_of_match_id;

    if (playerOfMatchId !== null) {
      const pom = await query(
        `SELECT id, team_id FROM players WHERE id = $1`,
        [playerOfMatchId]
      );
      if (!pom.rows.length) {
        return res.status(400).json({
          ok: false,
          error: "Oyunçu matçı tapılmadı"
        });
      }
      const pomTeam = Number(pom.rows[0].team_id);
      if (pomTeam !== Number(homeTeamId) && pomTeam !== Number(awayTeamId)) {
        return res.status(400).json({
          ok: false,
          error: "Oyunçu bu matçdakı komandalardan birinə aid olmalıdır"
        });
      }
    }

    if (
      homeTeamId &&
      awayTeamId &&
      homeTeamId === awayTeamId
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Eyni komanda ilə matç yaratmaq olmaz"
      });
    }

    const result =
      await query(
        `
          UPDATE matches
          SET
            home_team_id = $1,
            away_team_id = $2,
            home_score = $3,
            away_score = $4,
            status = $5,
            match_date = $6,
            venue = $7,
            player_of_match_id = $8
          WHERE id = $9
          RETURNING *
        `,
        [
          homeTeamId,
          awayTeamId,
          homeScore,
          awayScore,
          status,
          matchDate,
          venue,
          playerOfMatchId,
          id
        ]
      );

    res.json({
      ok: true,
      match:
        result.rows[0]
    });
  } catch (err) {
    console.error(
      "UPDATE MATCH ERROR:",
      err
    );

    res.status(400).json({
      ok: false,
      error: err.message
    });
  }
}

app.put(
  "/api/matches/:id",
  requireAdmin,
  updateMatch
);

app.patch(
  "/api/matches/:id",
  requireAdmin,
  updateMatch
);

app.delete(
  "/api/matches/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(req.params.id);

      await query(
        `
          DELETE FROM matches
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "DELETE MATCH ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   MATCH EVENTS
========================================================= */

app.get(
  "/api/matches/:matchId/events",
  async (req, res) => {
    try {
      const matchId =
        intValue(req.params.matchId);

      const result =
        await query(
          `
            SELECT
              e.*,
              p.name AS player_name,
              p.photo AS player_photo,
              p.number AS player_number,
              p.position AS player_position,
              t.name AS team_name,
              t.logo AS team_logo
            FROM match_events e
            LEFT JOIN players p
              ON p.id = e.player_id
            LEFT JOIN teams t
              ON t.id = e.team_id
            WHERE e.match_id = $1
            ORDER BY
              e.minute ASC,
              e.id ASC
          `,
          [matchId]
        );

      res.json({
        ok: true,
        events:
          result.rows
      });
    } catch (err) {
      console.error(
        "GET EVENTS ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   ADD EVENT
========================================================= */

app.post(
  "/api/matches/:matchId/events",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const matchId =
        intValue(
          req.params.matchId
        );

      const type =
        cleanString(
          req.body.type
        ).toLowerCase();

      const playerId =
        nullableInt(
          req.body.player_id !== undefined
            ? req.body.player_id
            : req.body.playerId
        );

      let teamId =
        nullableInt(
          req.body.team_id !== undefined
            ? req.body.team_id
            : req.body.teamId
        );

      const minute =
        intValue(
          req.body.minute
        );

      const note =
        cleanString(
          req.body.note
        );

      const allowedTypes = [
        "goal",
        "assist",
        "save",
        "yellow",
        "red"
      ];

      if (
        !allowedTypes.includes(type)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış hadisə tipi"
        });
      }

      await client.query("BEGIN");

      const matchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
            FOR UPDATE
          `,
          [matchId]
        );

      if (!matchResult.rows.length) {
        throw new Error(
          "Matç tapılmadı"
        );
      }

      const match =
        matchResult.rows[0];

      /*
        Əgər frontend komandanı göndərməyibsə,
        oyunçunun komandasını avtomatik götürürük.
      */
      if (
        !teamId &&
        playerId
      ) {
        const playerResult =
          await client.query(
            `
              SELECT team_id
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (
          playerResult.rows.length
        ) {
          teamId =
            playerResult.rows[0]
              .team_id;
        }
      }

      if (!teamId) {
        throw new Error(
          "Komanda seçilməlidir"
        );
      }

      if (
        Number(teamId) !==
          Number(
            match.home_team_id
          ) &&
        Number(teamId) !==
          Number(
            match.away_team_id
          )
      ) {
        throw new Error(
          "Bu komanda bu matçda iştirak etmir"
        );
      }

      if (playerId) {
        const playerResult =
          await client.query(
            `
              SELECT *
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (
          !playerResult.rows.length
        ) {
          throw new Error(
            "Oyunçu tapılmadı"
          );
        }

        const player =
          playerResult.rows[0];

        if (
          Number(player.team_id) !==
          Number(teamId)
        ) {
          throw new Error(
            "Oyunçu seçilən komandaya aid deyil"
          );
        }
      }

      const eventResult =
        await client.query(
          `
            INSERT INTO match_events
              (
                match_id,
                team_id,
                player_id,
                type,
                minute,
                note
              )
            VALUES
              ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            matchId,
            teamId,
            playerId,
            type,
            minute,
            note
          ]
        );

      const event =
        eventResult.rows[0];

      const statColumn =
        eventStatColumn(type);

      if (
        statColumn &&
        playerId
      ) {
        await client.query(
          `
            UPDATE players
            SET ${statColumn} =
              COALESCE(
                ${statColumn},
                0
              ) + 1
            WHERE id = $1
          `,
          [playerId]
        );
      }

      let updatedMatch =
        match;

      if (type === "goal") {
        const homeIncrement =
          Number(teamId) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const awayIncrement =
          Number(teamId) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

        const scoreResult =
          await client.query(
            `
              UPDATE matches
              SET
                home_score =
                  home_score + $1,
                away_score =
                  away_score + $2
              WHERE id = $3
              RETURNING *
            `,
            [
              homeIncrement,
              awayIncrement,
              matchId
            ]
          );

        updatedMatch =
          scoreResult.rows[0];
      }

      await client.query("COMMIT");

      let notificationTitle =
        "AliScore";

      let notificationBody =
        "Yeni hadisə";

      if (type === "goal") {
        notificationTitle =
          "⚽ QOL!";

        notificationBody =
          "Matçda yeni qol!";
      }

      if (type === "assist") {
        notificationTitle =
          "🎯 Assist";

        notificationBody =
          "Yeni assist qeydə alındı.";
      }

      if (type === "save") {
        notificationTitle =
          "🧤 Seyv";

        notificationBody =
          "Yeni seyv qeydə alındı.";
      }

      if (type === "yellow") {
        notificationTitle =
          "🟨 Sarı kart";

        notificationBody =
          "Oyunçu sarı kart aldı.";
      }

      if (type === "red") {
        notificationTitle =
          "🟥 Qırmızı kart";

        notificationBody =
          "Oyunçu qırmızı kart aldı.";
      }

      /*
        Artıq bütün hadisələr üçün
        notification yaradılır.
      */
      await notify(
        type,
        notificationTitle,
        notificationBody,
        {
          matchId,
          eventId: event.id,
          playerId,
          teamId
        }
      );

      const fullEventResult =
        await query(
          `
            SELECT
              e.*,
              p.name AS player_name,
              p.photo AS player_photo,
              p.number AS player_number,
              p.position AS player_position,
              t.name AS team_name,
              t.logo AS team_logo
            FROM match_events e
            LEFT JOIN players p
              ON p.id = e.player_id
            LEFT JOIN teams t
              ON t.id = e.team_id
            WHERE e.id = $1
          `,
          [event.id]
        );

      res.status(201).json({
        ok: true,
        event:
          fullEventResult.rows[0],
        match:
          updatedMatch
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "ADD EVENT ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Hadisə əlavə edilmədi"
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   UPDATE EVENT
========================================================= */

app.patch(
  "/api/matches/:matchId/events/:eventId",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const matchId =
        intValue(
          req.params.matchId
        );

      const eventId =
        intValue(
          req.params.eventId
        );

      await client.query("BEGIN");

      const matchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
            FOR UPDATE
          `,
          [matchId]
        );

      if (
        !matchResult.rows.length
      ) {
        throw new Error(
          "Matç tapılmadı"
        );
      }

      const match =
        matchResult.rows[0];

      const oldResult =
        await client.query(
          `
            SELECT *
            FROM match_events
            WHERE id = $1
              AND match_id = $2
            FOR UPDATE
          `,
          [
            eventId,
            matchId
          ]
        );

      if (
        !oldResult.rows.length
      ) {
        throw new Error(
          "Hadisə tapılmadı"
        );
      }

      const oldEvent =
        oldResult.rows[0];

      const type =
        req.body.type !== undefined
          ? cleanString(req.body.type).toLowerCase()
          : oldEvent.type;

      const playerId =
        req.body.player_id !== undefined
          ? nullableInt(req.body.player_id)
          : oldEvent.player_id;

      let teamId =
        req.body.team_id !== undefined
          ? nullableInt(req.body.team_id)
          : oldEvent.team_id;

      const minute =
        req.body.minute !== undefined
          ? intValue(req.body.minute)
          : oldEvent.minute;

      const note =
        req.body.note !== undefined
          ? cleanString(req.body.note)
          : oldEvent.note;

      const allowedTypes = [
        "goal",
        "assist",
        "save",
        "yellow",
        "red"
      ];

      if (
        !allowedTypes.includes(type)
      ) {
        throw new Error(
          "Yanlış hadisə tipi"
        );
      }

      if (
        !teamId &&
        playerId
      ) {
        const p =
          await client.query(
            `
              SELECT team_id
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (p.rows.length) {
          teamId =
            p.rows[0].team_id;
        }
      }

      if (!teamId) {
        throw new Error(
          "Komanda seçilməlidir"
        );
      }

      if (
        Number(teamId) !==
          Number(
            match.home_team_id
          ) &&
        Number(teamId) !==
          Number(
            match.away_team_id
          )
      ) {
        throw new Error(
          "Bu komanda bu matçda iştirak etmir"
        );
      }

      if (playerId) {
        const p =
          await client.query(
            `
              SELECT *
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (!p.rows.length) {
          throw new Error(
            "Oyunçu tapılmadı"
          );
        }

        if (
          Number(
            p.rows[0].team_id
          ) !==
          Number(teamId)
        ) {
          throw new Error(
            "Oyunçu seçilən komandaya aid deyil"
          );
        }
      }

      /* Remove old stat */

      const oldStat =
        eventStatColumn(
          oldEvent.type
        );

      if (
        oldStat &&
        oldEvent.player_id
      ) {
        await client.query(
          `
            UPDATE players
            SET ${oldStat} =
              GREATEST(
                COALESCE(
                  ${oldStat},
                  0
                ) - 1,
                0
              )
            WHERE id = $1
          `,
          [
            oldEvent.player_id
          ]
        );
      }

      /* Remove old goal */

      if (
        oldEvent.type === "goal"
      ) {
        const oldHome =
          Number(
            oldEvent.team_id
          ) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const oldAway =
          Number(
            oldEvent.team_id
          ) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

        await client.query(
          `
            UPDATE matches
            SET
              home_score =
                GREATEST(
                  home_score - $1,
                  0
                ),
              away_score =
                GREATEST(
                  away_score - $2,
                  0
                )
            WHERE id = $3
          `,
          [
            oldHome,
            oldAway,
            matchId
          ]
        );
      }

      const updatedResult =
        await client.query(
          `
            UPDATE match_events
            SET
              team_id = $1,
              player_id = $2,
              type = $3,
              minute = $4,
              note = $5
            WHERE id = $6
              AND match_id = $7
            RETURNING *
          `,
          [
            teamId,
            playerId,
            type,
            minute,
            note,
            eventId,
            matchId
          ]
        );

      const updatedEvent =
        updatedResult.rows[0];

      /* Add new stat */

      const newStat =
        eventStatColumn(type);

      if (
        newStat &&
        playerId
      ) {
        await client.query(
          `
            UPDATE players
            SET ${newStat} =
              COALESCE(
                ${newStat},
                0
              ) + 1
            WHERE id = $1
          `,
          [playerId]
        );
      }

      /* Add new goal */

      if (type === "goal") {
        const homeAdd =
          Number(teamId) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const awayAdd =
          Number(teamId) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

        await client.query(
          `
            UPDATE matches
            SET
              home_score =
                home_score + $1,
              away_score =
                away_score + $2
            WHERE id = $3
          `,
          [
            homeAdd,
            awayAdd,
            matchId
          ]
        );
      }

      const finalMatchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
          `,
          [matchId]
        );

      await client.query("COMMIT");

      const fullEventResult =
        await query(
          `
            SELECT
              e.*,
              p.name AS player_name,
              p.photo AS player_photo,
              p.number AS player_number,
              p.position AS player_position,
              t.name AS team_name,
              t.logo AS team_logo
            FROM match_events e
            LEFT JOIN players p
              ON p.id = e.player_id
            LEFT JOIN teams t
              ON t.id = e.team_id
            WHERE e.id = $1
          `,
          [eventId]
        );

      res.json({
        ok: true,
        event:
          fullEventResult.rows[0],
        match:
          finalMatchResult.rows[0]
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "UPDATE EVENT ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   DELETE EVENT
========================================================= */

app.delete(
  "/api/matches/:matchId/events/:eventId",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const matchId =
        intValue(
          req.params.matchId
        );

      const eventId =
        intValue(
          req.params.eventId
        );

      await client.query("BEGIN");

      const matchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
            FOR UPDATE
          `,
          [matchId]
        );

      if (
        !matchResult.rows.length
      ) {
        throw new Error(
          "Matç tapılmadı"
        );
      }

      const eventResult =
        await client.query(
          `
            SELECT *
            FROM match_events
            WHERE id = $1
              AND match_id = $2
            FOR UPDATE
          `,
          [
            eventId,
            matchId
          ]
        );

      if (
        !eventResult.rows.length
      ) {
        throw new Error(
          "Hadisə tapılmadı"
        );
      }

      const event =
        eventResult.rows[0];

      const stat =
        eventStatColumn(
          event.type
        );

      if (
        stat &&
        event.player_id
      ) {
        await client.query(
          `
            UPDATE players
            SET ${stat} =
              GREATEST(
                COALESCE(
                  ${stat},
                  0
                ) - 1,
                0
              )
            WHERE id = $1
          `,
          [event.player_id]
        );
      }

      if (
        event.type === "goal"
      ) {
        const match =
          matchResult.rows[0];

        const home =
          Number(
            event.team_id
          ) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const away =
          Number(
            event.team_id
          ) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

        await client.query(
          `
            UPDATE matches
            SET
              home_score =
                GREATEST(
                  home_score - $1,
                  0
                ),
              away_score =
                GREATEST(
                  away_score - $2,
                  0
                )
            WHERE id = $3
          `,
          [
            home,
            away,
            matchId
          ]
        );
      }

      await client.query(
        `
          DELETE FROM match_events
          WHERE id = $1
            AND match_id = $2
        `,
        [
          eventId,
          matchId
        ]
      );

      const updatedMatch =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
          `,
          [matchId]
        );

      await client.query("COMMIT");

      res.json({
        ok: true,
        deleted_event_id:
          eventId,
        match:
          updatedMatch.rows[0]
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "DELETE EVENT ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   CARDS
========================================================= */

app.get(
  "/api/cards",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            p.id,
            p.name,
            p.photo,
            p.yellow_cards,
            p.red_cards,
            p.team_id,
            t.name AS team_name
          FROM players p
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            p.yellow_cards DESC,
            p.red_cards DESC,
            p.name ASC
        `);

      res.json({
        ok: true,
        cards:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/cards/change",
  requireAdmin,
  async (req, res) => {
    try {
      const playerId =
        intValue(
          req.body.player_id
        );

      const card =
        cleanString(
          req.body.card
        );

      const delta =
        intValue(
          req.body.delta,
          1
        );

      if (
        !playerId ||
        ![
          "yellow",
          "red"
        ].includes(card)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış kart məlumatı"
        });
      }

      const column =
        card === "yellow"
          ? "yellow_cards"
          : "red_cards";

      const result =
        await query(
          `
            UPDATE players
            SET ${column} =
              GREATEST(
                COALESCE(
                  ${column},
                  0
                ) + $1,
                0
              )
            WHERE id = $2
            RETURNING *
          `,
          [
            delta,
            playerId
          ]
        );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "Oyunçu tapılmadı"
        });
      }

      if (delta > 0) {
        await notify(
          card,
          card === "yellow"
            ? "🟨 Sarı kart"
            : "🟥 Qırmızı kart",
          card === "yellow"
            ? "Oyunçu sarı kart aldı."
            : "Oyunçu qırmızı kart aldı.",
          {
            playerId,
            card
          }
        );
      }

      res.json({
        ok: true,
        player:
          result.rows[0]
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   STATISTICS
========================================================= */

app.get(
  "/api/statistics",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            p.*,
            t.name AS team_name
          FROM players p
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            p.goals DESC,
            p.assists DESC,
            p.saves DESC,
            p.name ASC
        `);

      res.json({
        ok: true,
        statistics:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/statistics/change",
  requireAdmin,
  async (req, res) => {
    try {
      const playerId =
        intValue(
          req.body.player_id
        );

      const stat =
        cleanString(
          req.body.stat
        );

      const delta =
        intValue(
          req.body.delta,
          1
        );

      const allowed = [
        "goals",
        "assists",
        "saves"
      ];

      if (
        !playerId ||
        !allowed.includes(stat)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış statistika"
        });
      }

      const result =
        await query(
          `
            UPDATE players
            SET ${stat} =
              GREATEST(
                COALESCE(
                  ${stat},
                  0
                ) + $1,
                0
              )
            WHERE id = $2
            RETURNING *
          `,
          [
            delta,
            playerId
          ]
        );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "Oyunçu tapılmadı"
        });
      }

      res.json({
        ok: true,
        player:
          result.rows[0]
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   NOTIFICATIONS
========================================================= */

app.get(
  "/api/notifications",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT *
          FROM notifications
          ORDER BY
            created_at DESC,
            id DESC
          LIMIT 100
        `);

      res.json({
        ok: true,
        notifications:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   TRANSFERS
========================================================= */

app.get(
  "/api/transfers",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            tr.*,
            p.name AS player_name,
            p.photo AS player_photo,
            ft.name AS from_team_name,
            tt.name AS to_team_name
          FROM transfers tr
          LEFT JOIN players p
            ON p.id = tr.player_id
          LEFT JOIN teams ft
            ON ft.id = tr.from_team_id
          LEFT JOIN teams tt
            ON tt.id = tr.to_team_id
          ORDER BY
            tr.created_at DESC,
            tr.id DESC
        `);

      res.json({
        ok: true,
        transfers:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/transfers",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const playerId =
        intValue(
          req.body.player_id
        );

      const toTeamId =
        intValue(
          req.body.to_team_id
        );

      const note =
        cleanString(
          req.body.note
        );

      const transferFeeRaw = req.body.transfer_fee;
      const transferFee = Number(transferFeeRaw);

      if (!playerId || !toTeamId) {
        throw new Error(
          "Oyunçu və yeni komanda seçilməlidir"
        );
      }

      if (!Number.isFinite(transferFee) || transferFee < 0) {
        throw new Error(
          "Transfer qiyməti düzgün daxil edilməlidir"
        );
      }

      await client.query("BEGIN");

      const playerResult =
        await client.query(
          `
            SELECT *
            FROM players
            WHERE id = $1
            FOR UPDATE
          `,
          [playerId]
        );

      if (
        !playerResult.rows.length
      ) {
        throw new Error(
          "Oyunçu tapılmadı"
        );
      }

      const player =
        playerResult.rows[0];

      if (
        Number(player.team_id) ===
        Number(toTeamId)
      ) {
        throw new Error(
          "Oyunçu artıq bu komandadadır"
        );
      }

      const teamResult =
        await client.query(
          `
            SELECT *
            FROM teams
            WHERE id = $1
          `,
          [toTeamId]
        );

      if (
        !teamResult.rows.length
      ) {
        throw new Error(
          "Yeni komanda tapılmadı"
        );
      }

      const fromTeamId =
        player.team_id;

      await client.query(
        `
          UPDATE players
          SET team_id = $1
          WHERE id = $2
        `,
        [
          toTeamId,
          playerId
        ]
      );

      const transferResult =
        await client.query(
          `
            INSERT INTO transfers
              (
                player_id,
                from_team_id,
                to_team_id,
                transfer_fee,
                note
              )
            VALUES
              ($1, $2, $3, $4, $5)
            RETURNING *
          `,
          [
            playerId,
            fromTeamId,
            toTeamId,
            transferFee,
            note
          ]
        );

      await client.query("COMMIT");

      const feeText = transferFee > 0
        ? `💰 ${new Intl.NumberFormat("az-AZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(transferFee)} ₼`
        : "💰 Pulsuz";

      await notify(
        "transfer",
        "🔄 Transfer",
        `${player.name} yeni komandaya keçdi. ${feeText}`,
        {
          playerId,
          fromTeamId,
          toTeamId,
          transferFee
        }
      );

      res.json({
        ok: true,
        transfer:
          transferResult.rows[0]
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      res.status(400).json({
        ok: false,
        error: err.message
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   GOAL OF THE WEEK / HƏFTƏNİN QOLU
========================================================= */

function getVoterId(req, res) {
  let id = cleanString(req.cookies && req.cookies.aliscore_voter_id);
  if (!id || id.length < 20 || id.length > 100) {
    id = crypto.randomUUID();
    res.cookie("aliscore_voter_id", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2
    });
  }
  return id;
}

app.get("/api/goal-of-week", async (req, res) => {
  try {
    const pollResult = await query(`
      SELECT id, title, week, status, created_at, closed_at
      FROM goal_of_week_polls
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    if (!pollResult.rows.length) return res.json({ ok: true, poll: null, candidates: [], totalVotes: 0, winner: null });

    const poll = pollResult.rows[0];
    const result = await query(`
      SELECT
        c.id,
        c.poll_id,
        c.player_id,
        p.name AS player_name,
        p.photo AS player_photo,
        p.number AS player_number,
        p.team_id,
        t.name AS team_name,
        c.match_id,
        m.home_team_id,
        ht.name AS home_team_name,
        m.away_team_id,
        at.name AS away_team_name,
        m.home_score,
        m.away_score,
        m.match_date,
        c.video_url,
        c.description,
        c.created_at,
        COUNT(v.id)::int AS votes
      FROM goal_of_week_candidates c
      LEFT JOIN players p ON p.id = c.player_id
      LEFT JOIN teams t ON t.id = p.team_id
      LEFT JOIN matches m ON m.id = c.match_id
      LEFT JOIN teams ht ON ht.id = m.home_team_id
      LEFT JOIN teams at ON at.id = m.away_team_id
      LEFT JOIN goal_of_week_votes v ON v.candidate_id = c.id
      WHERE c.poll_id = $1
      GROUP BY c.id, p.id, t.id, m.id, ht.id, at.id
      ORDER BY votes DESC, c.id ASC
    `, [poll.id]);

    const totalVotes = result.rows.reduce((n, x) => n + Number(x.votes || 0), 0);
    const candidates = result.rows.map(x => ({
      ...x,
      votes: Number(x.votes || 0),
      percentage: totalVotes ? Math.round((Number(x.votes || 0) / totalVotes) * 1000) / 10 : 0
    }));
    const winner = poll.status === "closed" && candidates.length ? candidates[0] : null;

    res.json({ ok: true, poll, candidates, totalVotes, winner });
  } catch (err) {
    console.error("GET GOAL OF WEEK ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/goal-of-week/vote", async (req, res) => {
  const candidateId = nullableInt(req.body && (req.body.candidate_id ?? req.body.candidateId));
  if (!candidateId) return res.status(400).json({ ok: false, error: "Qol seçilməyib" });
  const voterId = getVoterId(req, res);
  try {
    const candidate = await query(`
      SELECT c.id, c.poll_id, p.status
      FROM goal_of_week_candidates c
      JOIN goal_of_week_polls p ON p.id = c.poll_id
      WHERE c.id = $1
    `, [candidateId]);
    if (!candidate.rows.length) return res.status(404).json({ ok: false, error: "Qol tapılmadı" });
    if (candidate.rows[0].status !== "open") return res.status(400).json({ ok: false, error: "Səsvermə bağlıdır" });

    await query(`
      INSERT INTO goal_of_week_votes (poll_id, candidate_id, voter_id)
      VALUES ($1, $2, $3)
    `, [candidate.rows[0].poll_id, candidateId, voterId]);

    res.json({ ok: true });
  } catch (err) {
    if (String(err.message || "").toLowerCase().includes("unique")) {
      return res.status(409).json({ ok: false, error: "Siz artıq bu həftə səs vermisiniz" });
    }
    console.error("GOAL VOTE ERROR:", err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/goal-of-week/poll", requireAdmin, async (req, res) => {
  try {
    const title = cleanString(req.body && req.body.title) || "Həftənin qolu";
    const week = cleanString(req.body && req.body.week) || new Date().toISOString().slice(0, 10);
    const old = await query(`UPDATE goal_of_week_polls SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE status='open'`);
    const result = await query(`
      INSERT INTO goal_of_week_polls (title, week, status)
      VALUES ($1, $2, 'open')
      RETURNING id, title, week, status, created_at
    `, [title, week]);
    res.json({ ok: true, poll: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/goal-of-week/candidate", requireAdmin, async (req, res) => {
  try {
    const poll = await query(`SELECT id FROM goal_of_week_polls WHERE status='open' ORDER BY id DESC LIMIT 1`);
    if (!poll.rows.length) return res.status(400).json({ ok: false, error: "Əvvəlcə səsvermə yaradın" });
    const playerId = nullableInt(req.body && (req.body.player_id ?? req.body.playerId));
    const matchId = nullableInt(req.body && (req.body.match_id ?? req.body.matchId));
    const videoUrl = cleanString(req.body && (req.body.video_url ?? req.body.videoUrl));
    const description = cleanString(req.body && req.body.description);
    if (!playerId || !videoUrl) return res.status(400).json({ ok: false, error: "Oyunçu və video linki tələb olunur" });
    const result = await query(`
      INSERT INTO goal_of_week_candidates (poll_id, player_id, match_id, video_url, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [poll.rows[0].id, playerId, matchId, videoUrl, description]);
    res.json({ ok: true, candidate: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/goal-of-week/close", requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      UPDATE goal_of_week_polls
      SET status='closed', closed_at=CURRENT_TIMESTAMP
      WHERE id = COALESCE($1, (SELECT id FROM goal_of_week_polls ORDER BY id DESC LIMIT 1))
      RETURNING id, title, week, status, closed_at
    `, [nullableInt(req.body && (req.body.poll_id ?? req.body.pollId))]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Səsvermə tapılmadı" });
    await notify('goal-of-week', '⚽ Həftənin qolu', 'Həftənin qolu seçildi!', { pollId: result.rows[0].id });
    res.json({ ok: true, poll: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/goal-of-week/candidate/:id", requireAdmin, async (req, res) => {
  try {
    await query(`DELETE FROM goal_of_week_candidates WHERE id=$1`, [intValue(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* =========================================================
   TEAM OF THE WEEK
========================================================= */

app.get(
  "/api/team-of-week",
  async (req, res) => {
    try {
      const result = await query(`
        SELECT
          twp.id,
          twp.team_of_week_id,
          twp.position,
          twp.player_id,
          p.name,
          p.photo,
          p.number,
          p.team_id,
          t.name AS team_name,
          tw.week
        FROM team_of_week_players twp
        JOIN team_of_week tw
          ON tw.id = twp.team_of_week_id
        LEFT JOIN players p
          ON p.id = twp.player_id
        LEFT JOIN teams t
          ON t.id = p.team_id
        WHERE tw.id = (SELECT id FROM team_of_week ORDER BY created_at DESC, id DESC LIMIT 1)
        ORDER BY
          CASE twp.position
            WHEN 'Qapıçı' THEN 1
            WHEN 'Müdafiəçi' THEN 2
            WHEN 'Müdafiə' THEN 2
            WHEN 'Yarımmüdafiəçi' THEN 3
            WHEN 'Yarımmüdafiə' THEN 3
            WHEN 'Hücumçu' THEN 4
            WHEN 'Hücum' THEN 4
            ELSE 5
          END,
          twp.id ASC
      `);

      if (result.rows.length) {
        return res.json(result.rows);
      }

      // Compatibility fallback for old databases that only have the 4 player columns.
      const legacy = await query(`
        SELECT
          tw.id,
          tw.week,
          p.id AS player_id,
          p.name,
          p.photo,
          p.number,
          p.team_id,
          t.name AS team_name,
          v.position
        FROM team_of_week tw
        CROSS JOIN LATERAL (VALUES
          (tw.goalkeeper_id, 'Qapıçı'),
          (tw.defender_id, 'Müdafiəçi'),
          (tw.midfielder_id, 'Yarımmüdafiəçi'),
          (tw.attacker_id, 'Hücumçu')
        ) AS v(player_id, position)
        LEFT JOIN players p ON p.id = v.player_id
        LEFT JOIN teams t ON t.id = p.team_id
        WHERE tw.id = (SELECT id FROM team_of_week ORDER BY created_at DESC, id DESC LIMIT 1)
          AND v.player_id IS NOT NULL
        ORDER BY v.position
      `);

      return res.json(legacy.rows);
    } catch (err) {
      console.error("GET TEAM OF WEEK ERROR:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

app.post(
  "/api/team-of-week",
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const week = cleanString(req.body.week) || new Date().toISOString().slice(0, 10);
      let players = Array.isArray(req.body.players) ? req.body.players : null;

      // Support the older 4-player API as well.
      if (!players) {
        players = [
          { player_id: req.body.goalkeeper_id, position: 'Qapıçı' },
          { player_id: req.body.defender_id, position: 'Müdafiəçi' },
          { player_id: req.body.midfielder_id, position: 'Yarımmüdafiəçi' },
          { player_id: req.body.attacker_id, position: 'Hücumçu' }
        ];
      }

      players = players.map(x => ({
        player_id: nullableInt(x.player_id ?? x.playerId ?? x.id),
        position: cleanString(x.position)
      })).filter(x => x.player_id);

      if (players.length !== (Array.isArray(req.body.players) ? 11 : 4)) {
        return res.status(400).json({ ok: false, error: Array.isArray(req.body.players) ? '11 oyunçu seçilməlidir' : 'Bütün 4 mövqe seçilməlidir' });
      }

      if (new Set(players.map(x => x.player_id)).size !== players.length) {
        return res.status(400).json({ ok: false, error: 'Eyni oyunçu iki dəfə seçilə bilməz' });
      }

      if (players.length === 11) {
        const counts = { 'Qapıçı': 0, 'Müdafiəçi': 0, 'Yarımmüdafiəçi': 0, 'Hücumçu': 0 };
        for (const item of players) {
          if (counts[item.position] === undefined) {
            return res.status(400).json({ ok: false, error: 'Mövqe düzgün deyil' });
          }
          counts[item.position]++;
        }
        if (counts['Qapıçı'] !== 1 || counts['Müdafiəçi'] !== 4 || counts['Yarımmüdafiəçi'] !== 3 || counts['Hücumçu'] !== 3) {
          return res.status(400).json({ ok: false, error: 'Düzülüş: 1 Qapıçı, 4 Müdafiəçi, 3 Yarımmüdafiəçi, 3 Hücumçu' });
        }
      }

      const ids = players.map(x => x.player_id);
      const existing = await client.query('SELECT id FROM players WHERE id = ANY($1::int[])', [ids]);
      if (existing.rows.length !== ids.length) {
        return res.status(400).json({ ok: false, error: 'Seçilmiş oyunçulardan biri tapılmadı' });
      }

      await client.query('BEGIN');
      await client.query('DELETE FROM team_of_week');

      const g = players.find(x => x.position === 'Qapıçı')?.player_id || null;
      const d = players.find(x => x.position === 'Müdafiəçi')?.player_id || null;
      const m = players.find(x => x.position === 'Yarımmüdafiəçi')?.player_id || null;
      const a = players.find(x => x.position === 'Hücumçu')?.player_id || null;

      const weekResult = await client.query(`
        INSERT INTO team_of_week (week, goalkeeper_id, defender_id, midfielder_id, attacker_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, week, created_at
      `, [week, g, d, m, a]);

      const weekId = weekResult.rows[0].id;
      for (const item of players) {
        await client.query(`
          INSERT INTO team_of_week_players (team_of_week_id, player_id, position)
          VALUES ($1, $2, $3)
        `, [weekId, item.player_id, item.position]);
      }

      await client.query('COMMIT');

      await notify('team-of-week', '⭐ Komanda həftəsi', 'Yeni Komanda həftəsi seçildi!', { id: weekId, week });

      res.json({ ok: true, teamOfWeek: weekResult.rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('SAVE TEAM OF WEEK ERROR:', err);
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   LINEUPS
========================================================= */

app.get("/api/lineups/:id", async (req, res) => {
  try {
    const matchId = intValue(req.params.id);
    const result = await query(`
      SELECT
        lp.id, lp.match_id, lp.team_id, lp.player_id, lp.position,
        p.name, p.number, p.photo, p.team_id AS player_team_id,
        t.name AS team_name
      FROM lineup_players lp
      LEFT JOIN players p ON p.id = lp.player_id
      LEFT JOIN teams t ON t.id = lp.team_id
      WHERE lp.match_id = $1
      ORDER BY lp.id ASC
    `, [matchId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/lineups", requireAdmin, async (req, res) => {
  try {
    const matchId = intValue(req.body.match_id);
    const playerId = intValue(req.body.player_id);
    const position = cleanString(req.body.position);
    if (!matchId || !playerId || !position) {
      return res.status(400).json({ ok: false, error: "Matç, oyunçu və mövqe tələb olunur" });
    }
    const player = await query("SELECT id, team_id, name FROM players WHERE id = $1", [playerId]);
    if (!player.rows.length) return res.status(404).json({ ok: false, error: "Oyunçu tapılmadı" });
    const exists = await query("SELECT id FROM lineup_players WHERE match_id=$1 AND player_id=$2", [matchId, playerId]);
    if (exists.rows.length) return res.status(400).json({ ok: false, error: "Bu oyunçu artıq heyətdədir" });
    const result = await query(`
      INSERT INTO lineup_players (match_id, team_id, player_id, position)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [matchId, player.rows[0].team_id, playerId, position]);
    res.status(201).json({ ok: true, lineup: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/lineups/:id/:playerId", requireAdmin, async (req, res) => {
  try {
    await query("DELETE FROM lineup_players WHERE match_id=$1 AND player_id=$2", [intValue(req.params.id), intValue(req.params.playerId)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* =========================================================
   PUSH
========================================================= */

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      ok: true,
      enabled:
        pushEnabled,
      publicKey:
        VAPID_PUBLIC_KEY ||
        null
    });
  }
);

app.post(
  "/api/push/subscribe",
  async (req, res) => {
    try {
      const subscription =
        req.body.subscription ||
        req.body;

      if (
        !subscription ||
        !subscription.endpoint ||
        !subscription.keys ||
        !subscription.keys.p256dh ||
        !subscription.keys.auth
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid push subscription"
        });
      }

      await query(
        `
          INSERT INTO push_subscriptions
            (
              endpoint,
              p256dh,
              auth
            )
          VALUES
            ($1, $2, $3)
          ON CONFLICT (endpoint)
          DO UPDATE SET
            p256dh =
              EXCLUDED.p256dh,
            auth =
              EXCLUDED.auth
        `,
        [
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth
        ]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/push/test",
  requireAdmin,
  async (req, res) => {
    try {
      await sendPush(
        "AliScore",
        "Push bildirişləri işləyir! ⚽",
        {
          test: true
        }
      );

      res.json({
        ok: true,
        pushEnabled
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   SERVICE WORKER
========================================================= */

app.get(
  "/service-worker.js",
  (req, res) => {
    res.setHeader(
      "Content-Type",
      "application/javascript"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );

    res.send(`
      self.addEventListener(
        "install",
        function(event) {
          self.skipWaiting();
        }
      );

      self.addEventListener(
        "activate",
        function(event) {
          event.waitUntil(
            self.clients.claim()
          );
        }
      );

      self.addEventListener(
        "push",
        function(event) {
          let data = {};

          try {
            data = event.data
              ? event.data.json()
              : {};
          } catch (e) {
            data = {
              title: "AliScore",
              body: event.data
                ? event.data.text()
                : ""
            };
          }

          const title =
            data.title ||
            "AliScore";

          const options = {
            body:
              data.body ||
              "Yeni bildiriş",
            icon:
              "/icon-192.png",
            badge:
              "/icon-192.png",
            data:
              data.data || {},
            vibrate:
              [200, 100, 200]
          };

          event.waitUntil(
            self.registration
              .showNotification(
                title,
                options
              )
          );
        }
      );

      self.addEventListener(
        "notificationclick",
        function(event) {
          event.notification.close();

          event.waitUntil(
            clients
              .matchAll({
                type: "window",
                includeUncontrolled: true
              })
              .then(function(clientList) {
                for (
                  const client of
                    clientList
                ) {
                  if (
                    "focus" in client
                  ) {
                    return client.focus();
                  }
                }

                if (
                  clients.openWindow
                ) {
                  return clients.openWindow(
                    "/"
                  );
                }
              })
          );
        }
      );
    `);
  }
);


/* =========================================================
   HALL OF FAME API
========================================================= */

app.get("/api/hall-of-fame", async (req, res) => {
  try {
    const data = await getHallOfFame(
      cleanString(req.query.season) || previousSeasonForDate(new Date())
    );
    res.json(data);
  } catch (err) {
    console.error("Hall of Fame GET error:", err);
    res.status(500).json({ ok:false, error:err.message });
  }
});

app.get("/api/hall-of-fame/seasons", async (req, res) => {
  try {
    const result = await query(`
      SELECT season, archived_at
      FROM season_archives
      ORDER BY season DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

app.post("/api/admin/hall-of-fame/archive", requireAdmin, async (req, res) => {
  try {
    const season = cleanString(req.body.season) || previousSeasonForDate(new Date());
    const result = await archiveSeason(season);
    res.json({ ok:true, ...result });
  } catch (err) {
    console.error("Hall of Fame archive error:", err);
    res.status(500).json({ ok:false, error:err.message });
  }
});

/* =========================================================
   UNKNOWN API
========================================================= */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "API route not found",
      path: req.path
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

app.use(
  (req, res, next) => {
    if (req.method !== "GET") {
      return next();
    }

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      ),
      (err) => {
        if (err) {
          next(err);
        }
      }
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "Unhandled server error:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error:
        err.message ||
        "Server error"
    });
  }
);

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    await initDatabase();

    await checkSeasonRollover();
    // Keep the automatic May 31 season check alive while the server stays up.
    setInterval(() => {
      checkSeasonRollover().catch(err =>
        console.error("Season rollover check:", err)
      );
    }, 6 * 60 * 60 * 1000);

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `AliScore server running on port ${PORT}`
        );
      }
    );
  } catch (err) {
    console.error(
      "SERVER START ERROR:",
      err
    );

    process.exit(1);
  }
}

start();
