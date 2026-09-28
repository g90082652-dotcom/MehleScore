const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
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
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
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
     PUSH SUBSCRIPTIONS COMPATIBILITY / AUTO-FIX

     Older AliScore databases may already have a
     push_subscriptions table created without one or more
     Web Push columns. CREATE TABLE IF NOT EXISTS does not
     change an existing table, so we explicitly add any
     missing columns here. This keeps existing AliScore data.
  ======================================================= */

  await query(`
    ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS endpoint TEXT
  `);

  await query(`
    ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS p256dh TEXT
  `);

  await query(`
    ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS auth TEXT
  `);

  await query(`
    ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  /* Remove only incomplete old push rows. These rows cannot
     be used to send a Web Push notification anyway. */

  await query(`
    DELETE FROM push_subscriptions
    WHERE endpoint IS NULL
       OR endpoint = ''
       OR p256dh IS NULL
       OR p256dh = ''
       OR auth IS NULL
       OR auth = ''
  `);

  /* Make the columns compatible with the current push code. */

  await query(`
    ALTER TABLE push_subscriptions
    ALTER COLUMN endpoint SET NOT NULL
  `);

  await query(`
    ALTER TABLE push_subscriptions
    ALTER COLUMN p256dh SET NOT NULL
  `);

  await query(`
    ALTER TABLE push_subscriptions
    ALTER COLUMN auth SET NOT NULL
  `);

  /* The current INSERT uses ON CONFLICT(endpoint). Make sure
     an endpoint uniqueness rule exists even on old databases. */

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      push_subscriptions_endpoint_unique
    ON push_subscriptions(endpoint)
  `);

  /* =======================================================
     TEAMS COMPATIBILITY
  ======================================================= */
        const result = await query(`
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
        `);

        res.json({
          ok: true,
          players: result.rows
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
    "/api/players",
    requireAdmin,
    async (req, res) => {
      try {
        const teamId =
          nullableInt(req.body.team_id);

        const name =
          cleanString(req.body.name);

        const number =
          intValue(req.body.number);

        const position =
          cleanString(req.body.position);

        const photo =
          cleanString(req.body.photo);

        const rating =
          numberValue(req.body.rating, 0);

        if (!name) {
          return res.status(400).json({
            ok: false,
            error: "Oyunçu adı tələb olunur"
          });
        }

        const result = await query(
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
            photo,
            rating
          ]
        );

        res.json({
          ok: true,
          player: result.rows[0]
        });
      } catch (err) {
        res.status(400).json({
          ok: false,
          error: err.message
        });
      }
    }
  );

  async function updatePlayer(req, res) {
    try {
      const id =
        intValue(req.params.id);

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
          error: "Oyunçu tapılmadı"
        });
      }

      const old =
        current.rows[0];

      const teamId =
        req.body.team_id !== undefined
          ? nullableInt(req.body.team_id)
          : old.team_id;

      const name =
        req.body.name !== undefined
          ? cleanString(req.body.name)
          : old.name;

      const number =
        req.body.number !== undefined
          ? intValue(req.body.number)
          : old.number;

      const position =
        req.body.position !== undefined
          ? cleanString(req.body.position)
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

      const rating =
        req.body.rating !== undefined
          ? numberValue(req.body.rating)
          : numberValue(old.rating);

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
        player: result.rows[0]
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
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
        const result = await query(`
          SELECT
            m.*,
            ht.name AS home_team_name,
            ht.logo AS home_team_logo,
            at.name AS away_team_name,
            at.logo AS away_team_logo,
            pom.name AS player_of_match_name
          FROM matches m
          LEFT JOIN teams ht
            ON ht.id = m.home_team_id
          LEFT JOIN teams at
            ON at.id = m.away_team_id
          LEFT JOIN players pom
            ON pom.id = m.player_of_match_id
          ORDER BY
            m.match_date DESC,
            m.id DESC
        `);

        res.json({
          ok: true,
          matches: result.rows
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
    "/api/matches",
    requireAdmin,
    async (req, res) => {
      try {
        const homeTeamId =
          intValue(req.body.home_team_id);

        const awayTeamId =
          intValue(req.body.away_team_id);

        const homeScore =
          intValue(req.body.home_score);

        const awayScore =
          intValue(req.body.away_score);

        const status =
          cleanString(
            req.body.status || "scheduled"
          );

        const matchDate =
          req.body.match_date ||
          new Date().toISOString();

        const venue =
          cleanString(req.body.venue);

        if (
          !homeTeamId ||
          !awayTeamId
        ) {
          return res.status(400).json({
            ok: false,
            error: "Komandalar seçilməlidir"
          });
        }

        if (
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

        res.json({
          ok: true,
          match: result.rows[0]
        });
      } catch (err) {
        res.status(400).json({
          ok: false,
          error: err.message
        });
      }
    }
  );

  async function updateMatch(req, res) {
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
          error: "Matç tapılmadı"
        });
      }

      const old =
        current.rows[0];

      const homeTeamId =
        req.body.home_team_id !== undefined
          ? intValue(req.body.home_team_id)
          : old.home_team_id;

      const awayTeamId =
        req.body.away_team_id !== undefined
          ? intValue(req.body.away_team_id)
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
        match: result.rows[0]
      });
    } catch (err) {
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
        res.status(400).json({
          ok: false,
          error: err.message
        });
      }
    }
  );

  /* =========================================================
     PUSH SUBSCRIPTIONS
  ========================================================= */

  app.get(
    "/api/push/status",
    async (req, res) => {
      try {
        const result =
          await query(`
            SELECT COUNT(*)::INTEGER AS count
            FROM push_subscriptions
          `);

        res.json({
          ok: true,
          enabled: pushEnabled,
          publicKey:
            VAPID_PUBLIC_KEY || "",
          subscriptions:
            result.rows[0].count
        });
      } catch (err) {
        res.status(500).json({
          ok: false,
          enabled: pushEnabled,
          publicKey:
            VAPID_PUBLIC_KEY || "",
          error: err.message
        });
      }
    }
  );

  app.post(
    "/api/push/subscribe",
    async (req, res) => {
      try {
        const subscription =
          req.body &&
          req.body.subscription
            ? req.body.subscription
            : req.body;

        const endpoint =
          cleanString(
            subscription &&
            subscription.endpoint
          );

        const keys =
          subscription &&
          subscription.keys
            ? subscription.keys
            : {};

        const p256dh =
          cleanString(
            keys.p256dh
          );

        const auth =
          cleanString(
            keys.auth
          );

        if (
          !endpoint ||
          !p256dh ||
          !auth
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Yanlış push subscription"
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
              p256dh = EXCLUDED.p256dh,
              auth = EXCLUDED.auth
          `,
          [
            endpoint,
            p256dh,
            auth
          ]
        );

        res.json({
          ok: true,
          subscribed: true
        });
      } catch (err) {
        console.error(
          "Push subscribe error:",
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
    "/api/push/unsubscribe",
    async (req, res) => {
      try {
        const endpoint =
          cleanString(
            req.body &&
            req.body.endpoint
          );

        if (!endpoint) {
          return res.status(400).json({
            ok: false,
            error:
              "Endpoint tələb olunur"
          });
        }

        await query(
          `
            DELETE FROM push_subscriptions
            WHERE endpoint = $1
          `,
          [endpoint]
        );

        res.json({
          ok: true
        });
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err.message
        });
      }
    }
  );
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

      /*
        Rating:
        goal   +1
        assist +1
        save   +1
        yellow -1
        red    -2
      */

      if (
        playerId
      ) {
        const ratingDelta =
          type === "goal"
            ? 1
            : type === "assist"
              ? 1
              : type === "save"
                ? 1
                : type === "yellow"
                  ? -1
                  : type === "red"
                    ? -2
                    : 0;

        if (
          ratingDelta !== 0
        ) {
          await client.query(
            `
              UPDATE players
              SET rating =
                COALESCE(
                  rating,
                  0
                ) + $1
              WHERE id = $2
            `,
            [
              ratingDelta,
              playerId
            ]
          );
        }
      }

      await client.query(
        "COMMIT"
      );

      /*
        PUSH NOTIFICATION
      */

      try {
        const playerResult =
          playerId
            ? await query(
                `
                  SELECT name
                  FROM players
                  WHERE id = $1
                `,
                [playerId]
              )
            : {
                rows: []
              };

        const playerName =
          playerResult.rows.length
            ? playerResult.rows[0].name
            : "";

        let title =
          "AliScore";

        let body =
          "Yeni hadisə əlavə edildi";

        if (
          type === "goal"
        ) {
          title =
            "⚽ QOL!";

          body =
            `${playerName || "Oyunçu"} qol vurdu`;
        }

        if (
          type === "assist"
        ) {
          title =
            "🅰️ ASSİST!";

          body =
            `${playerName || "Oyunçu"} assist etdi`;
        }

        if (
          type === "save"
        ) {
          title =
            "🧤 SEYV!";

          body =
            `${playerName || "Qapıçı"} seyvlədi`;
        }

        if (
          type === "yellow"
        ) {
          title =
            "🟨 SARI KART";

          body =
            `${playerName || "Oyunçu"} sarı kart aldı`;
        }

        if (
          type === "red"
        ) {
          title =
            "🟥 QIRMIZI KART";

          body =
            `${playerName || "Oyunçu"} qırmızı kart aldı`;
        }

        await sendPushNotification(
          title,
          body
        );
      } catch (
        pushError
      ) {
        console.error(
          "PUSH EVENT ERROR:",
          pushError
        );
      }

      res.status(201).json({
        ok: true,
        event,
        match:
          updatedMatch
      });
    } catch (err) {
      await client.query(
        "ROLLBACK"
      );

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

app.put(
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

      const teamId =
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
        !allowedTypes.includes(
          type
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış hadisə tipi"
        });
      }

      await client.query(
        "BEGIN"
      );

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

      let finalTeamId =
        teamId;

      if (
        !finalTeamId &&
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
          finalTeamId =
            playerResult.rows[0]
              .team_id;
        }
      }

      if (!finalTeamId) {
        throw new Error(
          "Komanda seçilməlidir"
        );
      }

      if (
        Number(finalTeamId) !==
          Number(
            match.home_team_id
          ) &&
        Number(finalTeamId) !==
          Number(
            match.away_team_id
          )
      ) {
        throw new Error(
          "Bu komanda bu matçda iştirak etmir"
        );
      }

      if (
        playerId
      ) {
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

        if (
          Number(
            playerResult.rows[0]
              .team_id
          ) !==
          Number(finalTeamId)
        ) {
          throw new Error(
            "Oyunçu seçilən komandaya aid deyil"
          );
        }
      }

      /*
        Əvvəlki statistik təsiri geri qaytarırıq
      */

      const oldStatColumn =
        eventStatColumn(
          oldEvent.type
        );

      if (
        oldStatColumn &&
        oldEvent.player_id
      ) {
        await client.query(
          `
            UPDATE players
            SET ${oldStatColumn} =
              GREATEST(
                COALESCE(
                  ${oldStatColumn},
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

      /*
        Əvvəlki rating təsirini geri qaytarırıq
      */

      const oldRatingDelta =
        oldEvent.type === "goal"
          ? 1
          : oldEvent.type === "assist"
            ? 1
            : oldEvent.type === "save"
              ? 1
              : oldEvent.type === "yellow"
                ? -1
                : oldEvent.type === "red"
                  ? -2
                  : 0;

      if (
        oldEvent.player_id &&
        oldRatingDelta !== 0
      ) {
        await client.query(
          `
            UPDATE players
            SET rating =
              COALESCE(
                rating,
                0
              ) - $1
            WHERE id = $2
          `,
          [
            oldRatingDelta,
            oldEvent.player_id
          ]
        );
      }

      /*
        Əgər əvvəlki hadisə qol idisə,
        hesabdan çıxarırıq.
      */

      if (
        oldEvent.type ===
        "goal"
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

      /*
        Hadisəni yeniləyirik
      */

      const result =
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
            finalTeamId,
            playerId,
            type,
            minute,
            note,
            eventId,
            matchId
          ]
        );

      const event =
        result.rows[0];

      /*
        Yeni statistik təsiri tətbiq edirik
      */

      const newStatColumn =
        eventStatColumn(
          type
        );

      if (
        newStatColumn &&
        playerId
      ) {
        await client.query(
          `
            UPDATE players
            SET ${newStatColumn} =
              COALESCE(
                ${newStatColumn},
                0
              ) + 1
            WHERE id = $1
          `,
          [playerId]
        );
      }

      const newRatingDelta =
        type === "goal"
          ? 1
          : type === "assist"
            ? 1
            : type === "save"
              ? 1
              : type === "yellow"
                ? -1
                : type === "red"
                  ? -2
                  : 0;

      if (
        playerId &&
        newRatingDelta !== 0
      ) {
        await client.query(
          `
            UPDATE players
            SET rating =
              COALESCE(
                rating,
                0
              ) + $1
            WHERE id = $2
          `,
          [
            newRatingDelta,
            playerId
          ]
        );
      }

      /*
        Yeni hadisə qoludursa,
        hesaba əlavə edirik.
      */

      if (
        type === "goal"
      ) {
        const newHome =
          Number(finalTeamId) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const newAway =
          Number(finalTeamId) ===
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
            newHome,
            newAway,
            matchId
          ]
        );
      }

      const updatedMatchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
          `,
          [matchId]
        );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        event,
        match:
          updatedMatchResult.rows[0]
      });
    } catch (err) {
      await client.query(
        "ROLLBACK"
      );

      console.error(
        "UPDATE EVENT ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Hadisə yenilənmədi"
      });
    } finally {
      client.release();
    }
  }
);
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

      await client.query(
        "BEGIN"
      );

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

      /*
        Statistikadan çıxarırıq
      */

      const statColumn =
        eventStatColumn(
          event.type
        );

      if (
        statColumn &&
        event.player_id
      ) {
        await client.query(
          `
            UPDATE players
            SET ${statColumn} =
              GREATEST(
                COALESCE(
                  ${statColumn},
                  0
                ) - 1,
                0
              )
            WHERE id = $1
          `,
          [
            event.player_id
          ]
        );
      }

      /*
        Rating-i geri qaytarırıq
      */

      const ratingDelta =
        event.type === "goal"
          ? 1
          : event.type === "assist"
            ? 1
            : event.type === "save"
              ? 1
              : event.type === "yellow"
                ? -1
                : event.type === "red"
                  ? -2
                  : 0;

      if (
        event.player_id &&
        ratingDelta !== 0
      ) {
        await client.query(
          `
            UPDATE players
            SET rating =
              COALESCE(
                rating,
                0
              ) - $1
            WHERE id = $2
          `,
          [
            ratingDelta,
            event.player_id
          ]
        );
      }

      /*
        Əgər qol silinirsə,
        matç hesabından da çıxırıq.
      */

      if (
        event.type === "goal"
      ) {
        const homeMinus =
          Number(
            event.team_id
          ) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const awayMinus =
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
            homeMinus,
            awayMinus,
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

      const finalMatch =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
          `,
          [matchId]
        );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        match:
          finalMatch.rows[0]
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
          err.message ||
          "Hadisə silinmədi"
      });
    } finally {
      client.release();
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
      const players =
        await query(`
          SELECT
            p.*,
            t.name AS team_name,
            t.logo AS team_logo
          FROM players p
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            p.goals DESC,
            p.assists DESC,
            p.saves DESC,
            p.rating DESC,
            p.name ASC
        `);

      const scorers =
        [...players.rows]
          .sort(
            (a, b) =>
              Number(b.goals || 0) -
              Number(a.goals || 0)
          );

      const assists =
        [...players.rows]
          .sort(
            (a, b) =>
              Number(b.assists || 0) -
              Number(a.assists || 0)
          );

      const saves =
        [...players.rows]
          .sort(
            (a, b) =>
              Number(b.saves || 0) -
              Number(a.saves || 0)
          );

      const ratings =
        [...players.rows]
          .sort(
            (a, b) =>
              Number(b.rating || 0) -
              Number(a.rating || 0)
          );

      const yellowCards =
        [...players.rows]
          .sort(
            (a, b) =>
              Number(
                b.yellow_cards || 0
              ) -
              Number(
                a.yellow_cards || 0
              )
          );

      const redCards =
        [...players.rows]
          .sort(
            (a, b) =>
              Number(
                b.red_cards || 0
              ) -
              Number(
                a.red_cards || 0
              )
          );

      res.json({
        ok: true,
        players:
          players.rows,
        scorers,
        assists,
        saves,
        ratings,
        yellowCards,
        redCards
      });
    } catch (err) {
      console.error(
        "STATISTICS ERROR:",
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
   TEAM OF WEEK
========================================================= */

app.get(
  "/api/team-of-week",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            tow.*,
            p.name AS player_name,
            p.photo AS player_photo,
            p.position AS player_position,
            p.number AS player_number,
            t.name AS team_name,
            t.logo AS team_logo
          FROM team_of_week tow
          LEFT JOIN players p
            ON p.id = tow.player_id
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            tow.position ASC,
            tow.id ASC
        `);

      res.json({
        ok: true,
        teamOfWeek:
          result.rows
      });
    } catch (err) {
      console.error(
        "TEAM OF WEEK ERROR:",
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
  "/api/team-of-week",
  requireAdmin,
  async (req, res) => {
    try {
      const playerId =
        nullableInt(
          req.body.player_id !== undefined
            ? req.body.player_id
            : req.body.playerId
        );

      const position =
        cleanString(
          req.body.position
        );

      if (!playerId) {
        return res.status(400).json({
          ok: false,
          error:
            "Oyunçu seçilməlidir"
        });
      }

      const player =
        await query(
          `
            SELECT id
            FROM players
            WHERE id = $1
          `,
          [playerId]
        );

      if (
        !player.rows.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Oyunçu tapılmadı"
        });
      }

      const result =
        await query(
          `
            INSERT INTO team_of_week
              (
                player_id,
                position
              )
            VALUES
              ($1, $2)
            RETURNING *
          `,
          [
            playerId,
            position
          ]
        );

      res.status(201).json({
        ok: true,
        item:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        "ADD TEAM OF WEEK ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);
        throw new Error(
          "Oyunçu və yeni komanda seçilməlidir"
        );
      }

      await client.query(
        "BEGIN"
      );

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

      const fromTeamId =
        player.team_id;

      if (
        Number(fromTeamId) ===
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

      /*
        Oyunçunun komandasını dəyişirik
      */

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

      /*
        Transfer tarixçəsinə əlavə edirik
      */

      const transferResult =
        await client.query(
          `
            INSERT INTO transfers
              (
                player_id,
                from_team_id,
                to_team_id,
                note
              )
            VALUES
              ($1, $2, $3, $4)
            RETURNING *
          `,
          [
            playerId,
            fromTeamId,
            toTeamId,
            note
          ]
        );

      await client.query(
        "COMMIT"
      );

      await notify(
        "transfer",
        "🔄 Transfer",
        `${player.name} yeni komandaya keçdi.`,
        {
          playerId,
          fromTeamId,
          toTeamId
        }
      );

      res.status(201).json({
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

      console.error(
        "TRANSFER ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Transfer alınmadı"
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   LINEUPS
========================================================= */

app.get(
  "/api/lineups",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            l.*,
            p.name AS player_name,
            p.photo AS player_photo,
            p.position AS player_position,
            p.number AS player_number,
            t.name AS team_name,
            t.logo AS team_logo
          FROM lineups l
          LEFT JOIN players p
            ON p.id = l.player_id
          LEFT JOIN teams t
            ON t.id = l.team_id
          ORDER BY
            l.team_id ASC,
            l.position ASC,
            l.id ASC
        `);

      res.json({
        ok: true,
        lineups:
          result.rows
      });
    } catch (err) {
      console.error(
        "GET LINEUPS ERROR:",
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
  "/api/lineups",
  requireAdmin,
  async (req, res) => {
    try {
      const teamId =
        intValue(
          req.body.team_id
        );

      const playerId =
        intValue(
          req.body.player_id
        );

      const position =
        cleanString(
          req.body.position
        );

      if (
        !teamId ||
        !playerId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Komanda və oyunçu seçilməlidir"
        });
      }

      const result =
        await query(
          `
            INSERT INTO lineups
              (
                team_id,
                player_id,
                position
              )
            VALUES
              ($1, $2, $3)
            RETURNING *
          `,
          [
            teamId,
            playerId,
            position
          ]
        );

      res.status(201).json({
        ok: true,
        lineup:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        "ADD LINEUP ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);

app.delete(
  "/api/lineups/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(
          req.params.id
        );

      await query(
        `
          DELETE FROM lineups
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "DELETE LINEUP ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);

/* =========================================================
   TEAM OF WEEK DELETE
========================================================= */

app.delete(
  "/api/team-of-week/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(
          req.params.id
        );

      await query(
        `
          DELETE FROM team_of_week
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "DELETE TEAM OF WEEK ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);

/* =========================================================
   PUSH SUBSCRIPTIONS
========================================================= */

app.post(
  "/api/push/subscribe",
  async (req, res) => {
    try {
      const endpoint =
        cleanString(
          req.body.endpoint
        );

      const keys =
        req.body.keys || {};

      const p256dh =
        cleanString(
          keys.p256dh
        );

      const auth =
        cleanString(
          keys.auth
        );

      if (
        !endpoint ||
        !p256dh ||
        !auth
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış push məlumatı"
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
            p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth
        `,
        [
          endpoint,
          p256dh,
          auth
        ]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "PUSH SUBSCRIBE ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);

/* =========================================================
   PUSH TEST
========================================================= */

app.post(
  "/api/push/test",
  requireAdmin,
  async (req, res) => {
    try {
      await sendPushNotification(
        "AliScore",
        "Test bildirişi uğurla göndərildi."
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "PUSH TEST ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);
          "Oyunçu və yeni komanda seçilməlidir"
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
                note
              )
            VALUES
              ($1, $2, $3, $4)
            RETURNING *
          `,
          [
            playerId,
            fromTeamId,
            toTeamId,
            note
          ]
        );

      await client.query("COMMIT");

      await notify(
        "transfer",
        "🔄 Transfer",
        `${player.name} yeni komandaya keçdi.`,
        {
          playerId,
          fromTeamId,
          toTeamId
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
