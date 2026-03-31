const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET
};

const client = new line.Client(config);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ADMIN_ID = process.env.ADMIN_ID;

app.use(express.json());

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

app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type !== "message") continue;
    if (event.message.type !== "text") continue;

    const userId = event.source.userId;
    const text = event.message.text;

    const user = await getUser(userId);

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "OK " + text
    });
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("OK");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
