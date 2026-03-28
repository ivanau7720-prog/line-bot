const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== Supabase =====
const supabase = createClient(
  "https://riqystgmpvxwsebyavuo.supabase.co",
  "sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

// ===== 首页 =====
app.get("/", (req, res) => {
  res.send(`
    <h2>💰 后台充值系统</h2>

    <form method="POST" action="/topup">
      玩家 user_id:<br>
      <input name="user_id" required /><br><br>

      金额 (+1000 / -1000):<br>
      <input name="amount" required /><br><br>

      <button type="submit">充值</button>
    </form>

    <br><br>

    <form method="GET" action="/balance">
      查询余额 user_id:<br>
      <input name="user_id" required /><br><br>
      <button type="submit">查询</button>
    </form>
  `);
});

// ===== 充值 =====
app.post("/topup", async (req, res) => {
  const { user_id, amount } = req.body;

  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", user_id);

  if (!data || data.length === 0) {
    return res.send("❌ 找不到玩家");
  }

  let player = data[0];
  let newBalance = player.balance + parseInt(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", user_id);

  // 写入记录
  await supabase.from("transactions").insert([{
    user_id,
    name: player.name,
    amount: parseInt(amount),
    fee: 0,
    type: "topup"
  }]);

  res.send(`✅ 成功<br>${player.name} 余额 ${newBalance}`);
});

// ===== 查询余额 =====
app.get("/balance", async (req, res) => {
  const { user_id } = req.query;

  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", user_id);

  if (!data || data.length === 0) {
    return res.send("❌ 找不到玩家");
  }

  res.send(`💰 ${data[0].name} 余额：${data[0].balance}`);
});

app.listen(3001, () => {
  console.log("后台运行 http://localhost:3001");
});
