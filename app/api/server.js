const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const app = express();
app.use(express.json());

// Logs sur la sortie standard
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Sondes
app.get("/health", (_req, res) => res.status(200).send("OK"));
app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).send("READY");
  } catch (e) {
    console.error("DB not ready:", e.message);
    res.status(503).send("NOT READY");
  }
});

// CRUD
app.get("/tasks", async (_req, res) => {
  const r = await pool.query("SELECT * FROM tasks ORDER BY id");
  res.json(r.rows);
});
app.post("/tasks", async (req, res) => {
  const r = await pool.query(
    "INSERT INTO tasks(title) VALUES($1) RETURNING *", [req.body.title]);
  res.status(201).json(r.rows[0]);
});
app.put("/tasks/:id", async (req, res) => {
  const r = await pool.query(
    "UPDATE tasks SET done=$1 WHERE id=$2 RETURNING *",
    [req.body.done, req.params.id]);
  res.json(r.rows[0]);
});
app.delete("/tasks/:id", async (req, res) => {
  await pool.query("DELETE FROM tasks WHERE id=$1", [req.params.id]);
  res.status(204).end();
});

// Migration automatique, avec nouvelle tentative si la base n'est pas prête
async function init() {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS tasks (
         id SERIAL PRIMARY KEY,
         title TEXT NOT NULL,
         done BOOLEAN NOT NULL DEFAULT false)`);
    console.log("Connexion à la base réussie, table tasks prête");
  } catch (e) {
    console.error("Init échouée, nouvelle tentative dans 3 s:", e.message);
    setTimeout(init, 3000);
  }
}

const port = process.env.API_PORT;
app.listen(port, () => console.log(`API à l'écoute sur le port ${port}`));
init();
