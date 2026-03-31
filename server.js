const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== LINE 配置 =====
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

// ===== 获取或自动注册用户 =====
async function getUser(userId) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) {
    const newUser = {
      user_id: userId,
      balance: 0
    };

    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  return data;
}

// ===== LINE webhook（❗不能用 express.json）=====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const userId = event.source.userId;
      const text = event.message.text;

      const user = await getUser(userId);

      // ===== 指令 =====
      if (text === "/balance") {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "余额: " + user.balance
        });
        continue;
      }

      // 默认回复
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "OK " + text
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.log("ERROR:", err);
    res.sendStatus(500);
  }
});

// ===== Admin 后台（这里才用 JSON）=====
app.use("/admin", express.json());

// 查询余额
app.get("/admin/balance", async (req, res) => {
  const user = await getUser(req.query.user_id);
  if (!user) return res.send("找不到玩家");

  res.send("余额: " + user.balance);
});

// 充值
app.post("/admin/topup", async (req, res) => {
  const { user_id, amount } = req.body;

  const user = await getUser(user_id);
  if (!user) return res.send("找不到玩家");

  const newBalance = Number(user.balance) + Number(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", user_id);

  res.send("充值成功: " + newBalance);
});

// ===== 首页 =====
app.get("/", (req, res) => {
  res.send("BOT RUNNING");
});

// ===== 启动 =====
app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
