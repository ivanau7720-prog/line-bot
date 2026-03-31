const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// LINE config
const config = {
channelAccessToken: process.env.LINE_TOKEN,
channelSecret: process.env.LINE_SECRET
};

const client = new line.Client(config);

// Supabase
const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_KEY
);

// admin
const ADMIN_ID = process.env.ADMIN_ID;

// ===== admin route =====
const adminApp = express();
adminApp.use(express.urlencoded({ extended: true }));
adminApp.use(express.json());

// auto register
async function getUser(userId) {
const { data, error } = await supabase
.from("players")
.select("*")
.eq("user_id", userId)
.single();

if (error || !data) {
let name = "player";

```
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

return newUser;
```

}

return data;
}

// admin API
adminApp.get("/", (req, res) => {
res.send("admin ok");
});

adminApp.get("/balance", async (req, res) => {
const user = await getUser(req.query.user_id);
if (!user) return res.send("error");

res.send("balance: " + user.balance);
});

adminApp.post("/topup", async (req, res) => {
const user = await getUser(req.body.user_id);
if (!user) return res.send("error");

const newBalance = Number(user.balance) + Number(req.body.amount);

await supabase
.from("players")
.update({ balance: newBalance })
.eq("user_id", user.user_id);

res.send("ok: " + newBalance);
});

app.use("/admin", adminApp);

// webhook (IMPORTANT)
app.post("/webhook", line.middleware(config), async (req, res) => {
try {
const events = req.body.events || [];

```
for (const event of events) {
  if (event.type !== "message") continue;
  if (event.message.type !== "text") continue;

  const userId = event.source.userId;
  const text = event.message.text;

  const user = await getUser(userId);

  if (text === "/balance") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "balance: " + user.balance
    });
    continue;
  }

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "ok: " + text
  });
}

res.sendStatus(200);
```

} catch (err) {
console.log(err);
res.sendStatus(500);
}
});

// start
app.listen(process.env.PORT || 3000, () => {
console.log("running");
});
