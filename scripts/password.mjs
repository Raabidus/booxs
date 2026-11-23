import { emitKeypressEvents } from "node:readline";
import { readFileSync } from "node:fs";
import { createPasswordHash } from "../shared/password.ts";

async function hidden(question) {
  process.stdout.write(question);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    function done() {
      process.stdin.off("keypress", keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }
    function keypress(text, key) {
      if (key?.ctrl && key.name === "c") {
        done();
        reject(new Error("Cancelled."));
      } else if (key?.name === "return" || key?.name === "enter") {
        done();
        resolve(value);
      } else if (key?.name === "backspace")
        value = [...value].slice(0, -1).join("");
      else if (
        text &&
        !key?.ctrl &&
        !key?.meta &&
        !/[\x00-\x1f\x7f]/.test(text)
      )
        value += text;
    }
    process.stdin.on("keypress", keypress);
  });
}

try {
  let password;
  if (process.argv.includes("--stdin")) {
    password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  } else {
    if (!process.stdin.isTTY)
      throw new Error(
        "Use an interactive terminal, or --stdin for a password supplied through stdin.",
      );
    console.log(
      "Choose a separate Booxs password or passphrase (at least 16 characters). Input stays hidden.",
    );
    password = await hidden("Password: ");
    const confirm = await hidden("Confirm: ");
    if (password !== confirm) throw new Error("Passwords do not match.");
    console.log(
      "\nCopy the following hash into the Cloudflare build secret OWNER_PASSWORD_HASH:",
    );
  }
  console.log(await createPasswordHash(password));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
