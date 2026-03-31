const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== LINE =====
const config = {
channelAccessToken: process.env.LINE_TOKEN,
channelSecret: process.env.LINE_SECRET
};

const client = new line.Client(config);

// ===== Supabase =====
const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_KEY
);

// ===== 管理员 =====
const ADMIN_ID = process.env.ADMIN_ID;

// ===== 状态 =====
let gameOpen = false;
let bets = {};
let groupId = null;

// ===== 👉 分离 admin（重点）=====
const adminApp = express();
adminApp.use(express.urlencoded({ extended: true }));
adminApp.use(express.json());

// ===== 自动注册 =====
async function getUser(userId) {
try {
const { data, error } = await supabase
.from("players")
.select("*")
.eq("user_id", userId)
.single();

```
if (error || !data) {
  let name = "玩家";

  try {
    const profile = await client.getProfile(userId);
    name = profile.displayName;
  } catch {}

  const newUser = {
    user_id: userId,
    name,
    balance: 0,
    total_win: 0,
    total_lose: 0
  };

  await supabase.from("players").insert([newUser]);

  console.log("✅ 自动注册:", userId);

  return newUser;
}

return data;
```

} catch (err) {
console.log("❌ getUser error:", err);
return null;
}
}

// ===== 后台 =====
adminApp.get("/", (req, res) => {
res.send("后台正常运行");
});

adminApp.post("/topup", async (req, res) => {
const { user_id, amount } = req.body;

const user = await getUser(user_id);
if (!user) return res.send("❌ 错误");

const newBalance = Number(user.balance) + Number(amount);

await supabase
.from("players")
.update({ balance: newBalance })
.eq("user_id", user_id);

res.send(`✅ ${user.name} 余额 ${newBalance}`);
});

adminApp.get("/balance", async (req, res) => {
const { user_id } = req.query;

const user = await getUser(user_id);
if (!user) return res.send("❌ 错误");

res.send(`💰 ${user.name} 余额 ${user.balance}`);
});

// 👉 挂载 admin
app.use("/admin", adminApp);

// ===== webhook（绝对正确写法）=====
app.post("/webhook", line.middleware(config), async (req, res) => {
try {
const events = req.body.events || [];

```
for (const event of events) {

  if (event.type !== "message" || event.message.type !== "text") continue;

  const userId = event.source.userId;
  const text = event.message.text.trim().toUpperCase();

  if (event.source.type === "group") {
    groupId = event.source.groupId;
  }

  const user = await getUser(userId);
  if (!user) continue;

  if (text === "/BALANCE") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `💰 余额：${user.balance}`
    });
    continue;
  }

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "收到：" + text
  });
}

res.sendStatus(200);
```

} catch (err) {
console.log("❌ webhook error:", err);
res.sendStatus(500);
}
});

// ===== 启动 =====
app.listen(process.env.PORT || 3000, () => {
console.log("🚀 RUNNING");
});
