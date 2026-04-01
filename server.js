const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // фронтенд лежит в папке /public

// ─── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ─── Инициализация таблиц при старте ──────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id        SERIAL PRIMARY KEY,
      name      TEXT UNIQUE NOT NULL,
      qty       INTEGER NOT NULL DEFAULT 0,
      price     NUMERIC(10,2) NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cash_register (
      id      INTEGER PRIMARY KEY DEFAULT 1,
      balance NUMERIC(10,2) NOT NULL DEFAULT 0,
      CHECK (id = 1)
    );
  `);

  // Гарантируем, что строка кассы всегда существует
  await pool.query(`
    INSERT INTO cash_register (id, balance)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log("✅ Database initialised");
}

// ══════════════════════════════════════════════════════════════════════════════
//  INVENTORY ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// GET  /api/inventory  — список всех товаров
app.get("/api/inventory", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM inventory ORDER BY name ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// POST /api/inventory  — добавить товар (или увеличить кол-во если уже есть)
app.post("/api/inventory", async (req, res) => {
  const { name, qty } = req.body;

  if (!name || !qty || qty <= 0) {
    return res.status(400).json({ error: "Invalid name or qty" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO inventory (name, qty, price)
       VALUES ($1, $2, 0)
       ON CONFLICT (name)
       DO UPDATE SET qty = inventory.qty + $2
       RETURNING *`,
      [name.trim(), qty]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// PATCH /api/inventory/:name/qty  — изменить кол-во на delta (+/-)
// Автоматически обновляет кассу: продажа (delta < 0) → касса растёт
app.patch("/api/inventory/:name/qty", async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { delta } = req.body; // число, может быть отрицательным

  if (delta === undefined || isNaN(delta)) {
    return res.status(400).json({ error: "Invalid delta" });
  }

  try {
    // Получаем текущую цену товара
    const { rows: itemRows } = await pool.query(
      "SELECT price FROM inventory WHERE name = $1",
      [name]
    );
    if (!itemRows.length) return res.status(404).json({ error: "Not found" });

    const price = parseFloat(itemRows[0].price);

    // Обновляем количество (не ниже 0)
    const { rows } = await pool.query(
      `UPDATE inventory
       SET qty = GREATEST(qty + $1, 0)
       WHERE name = $2
       RETURNING *`,
      [delta, name]
    );

    // Обновляем кассу: продажа (−delta) увеличивает баланс
    const cashDelta = -(delta * price);
    await pool.query(
      "UPDATE cash_register SET balance = balance + $1 WHERE id = 1",
      [cashDelta]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// PATCH /api/inventory/:name/price  — обновить цену товара
app.patch("/api/inventory/:name/price", async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { price } = req.body;

  if (price === undefined || isNaN(price) || price < 0) {
    return res.status(400).json({ error: "Invalid price" });
  }

  try {
    const { rows } = await pool.query(
      "UPDATE inventory SET price = $1 WHERE name = $2 RETURNING *",
      [price, name]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// POST /api/inventory/:name/sell  — продать N единиц
app.post("/api/inventory/:name/sell", async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { qty } = req.body;

  if (!qty || qty <= 0) {
    return res.status(400).json({ error: "Invalid qty" });
  }

  try {
    const { rows: itemRows } = await pool.query(
      "SELECT price, qty FROM inventory WHERE name = $1",
      [name]
    );
    if (!itemRows.length) return res.status(404).json({ error: "Not found" });

    const price = parseFloat(itemRows[0].price);
    const sold = Math.min(qty, itemRows[0].qty); // нельзя продать больше чем есть

    const { rows } = await pool.query(
      `UPDATE inventory
       SET qty = qty - $1
       WHERE name = $2
       RETURNING *`,
      [sold, name]
    );

    const earned = sold * price;
    await pool.query(
      "UPDATE cash_register SET balance = balance + $1 WHERE id = 1",
      [earned]
    );

    res.json({ item: rows[0], earned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// DELETE /api/inventory/:name  — удалить товар
app.delete("/api/inventory/:name", async (req, res) => {
  const name = decodeURIComponent(req.params.name);

  try {
    await pool.query("DELETE FROM inventory WHERE name = $1", [name]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CASH REGISTER ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/cash  — получить баланс кассы
app.get("/api/cash", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT balance FROM cash_register WHERE id = 1"
    );
    res.json({ balance: rows[0].balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// PUT /api/cash  — вручную установить баланс кассы
app.put("/api/cash", async (req, res) => {
  const { balance } = req.body;

  if (balance === undefined || isNaN(balance)) {
    return res.status(400).json({ error: "Invalid balance" });
  }

  try {
    const { rows } = await pool.query(
      "UPDATE cash_register SET balance = $1 WHERE id = 1 RETURNING *",
      [balance]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// ─── Старт ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`🚀 Server running on port ${PORT}`)
    );
  })
  .catch((err) => {
    console.error("❌ Failed to init DB:", err);
    process.exit(1);
  });
