const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─── JSON-файл для хранения данных ───────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { inventory: {}, cashRegister: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { inventory: {}, cashRegister: 0 };
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ inventory, cashRegister }, null, 2));
}

// Загружаем данные при старте
const stored = loadData();
let inventory = stored.inventory;
let cashRegister = stored.cashRegister;

// ══════════════════════════════════════════════════════════════════════════════
//  INVENTORY ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/inventory — список всех товаров
app.get("/api/inventory", (req, res) => {
  const result = Object.entries(inventory).map(([name, data]) => ({
    name,
    qty: data.qty,
    price: data.price,
  }));
  res.json(result);
});

// POST /api/inventory — добавить товар
app.post("/api/inventory", (req, res) => {
  const { name, qty } = req.body;
  if (!name || !qty || qty <= 0) {
    return res.status(400).json({ error: "Invalid name or qty" });
  }

  if (!inventory[name]) {
    inventory[name] = { qty: 0, price: 0 };
  }
  inventory[name].qty += qty;
  saveData();

  res.json({ name, ...inventory[name] });
});

// PATCH /api/inventory/:name/qty — изменить количество на delta (+/-)
app.patch("/api/inventory/:name/qty", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { delta } = req.body;

  if (!inventory[name]) return res.status(404).json({ error: "Not found" });
  if (delta === undefined || isNaN(delta)) return res.status(400).json({ error: "Invalid delta" });

  inventory[name].qty = Math.max(0, inventory[name].qty + delta);

  // Продажа (delta < 0) увеличивает кассу
  cashRegister -= delta * inventory[name].price;
  saveData();

  res.json({ name, ...inventory[name] });
});

// PATCH /api/inventory/:name/price — обновить цену
app.patch("/api/inventory/:name/price", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { price } = req.body;

  if (!inventory[name]) return res.status(404).json({ error: "Not found" });
  if (price === undefined || isNaN(price) || price < 0) return res.status(400).json({ error: "Invalid price" });

  inventory[name].price = parseFloat(price);
  saveData();
  res.json({ name, ...inventory[name] });
});

// POST /api/inventory/:name/sell — продать N штук
app.post("/api/inventory/:name/sell", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { qty } = req.body;

  if (!inventory[name]) return res.status(404).json({ error: "Not found" });
  if (!qty || qty <= 0) return res.status(400).json({ error: "Invalid qty" });

  const sold = Math.min(qty, inventory[name].qty);
  inventory[name].qty -= sold;

  const earned = sold * inventory[name].price;
  cashRegister += earned;
  saveData();

  res.json({ name, ...inventory[name], earned });
});

// DELETE /api/inventory/:name — удалить товар
app.delete("/api/inventory/:name", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  delete inventory[name];
  saveData();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  CASH REGISTER ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/cash — получить баланс
app.get("/api/cash", (req, res) => {
  res.json({ balance: cashRegister });
});

// PUT /api/cash — вручную задать баланс
app.put("/api/cash", (req, res) => {
  const { balance } = req.body;
  if (balance === undefined || isNaN(balance)) {
    return res.status(400).json({ error: "Invalid balance" });
  }
  cashRegister = parseFloat(balance);
  saveData();
  res.json({ balance: cashRegister });
});

// ─── Старт ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
