# Steady

From shaky to steady. A study app for Chemistry that runs on this Mac only. It needs no internet connection and sends nothing anywhere.

## Before the first start

Steady needs **Node.js version 20 or newer**. To check, open the Terminal app, type `node --version` and press Return. If you see `v20` or a higher number, you are ready. If not, install the "LTS" version from nodejs.org.

## Start Steady

1. Open the `app` folder in Finder.
2. Double-click **Start Steady.command**.
   - The first time, macOS may say it "cannot be opened because it is from an unidentified developer". If so, right-click (or Control-click) the file, choose **Open**, then click **Open** again. You only need to do this once.
3. A Terminal window opens and your web browser opens Steady at **http://localhost:4600**. Keep the Terminal window open while Steady is in use.

If the browser does not open by itself, open it yourself and go to http://localhost:4600.

## First-run setup (once only)

The first time Steady starts, it shows a setup page. Create two accounts:

- **Parent account:** a username and a password for you.
- **Student account:** a username and a password for your child.

Each password must be at least 8 characters. Write them down somewhere safe. After setup you are taken to the login page, and the setup page is gone for good.

## Log in

- Your child logs in with the student account and sees their Chemistry dashboard.
- You log in with the parent account and see the parent page.
- To log out, click **Log out** at the top right. Steady also logs out by itself after 20 minutes without use.

## See the demo states

The student dashboard looks different depending on how far along your child is. To see each version without answering any questions, open Terminal and type these lines, pressing Return after each. Replace the path with wherever the `app` folder is (you can drag the folder into the Terminal window to type its path).

```
cd "/path/to/app"
npm run seed-demo -- first-time
```

Then reload the dashboard in the browser. The three states are:

| Command | What the dashboard shows |
|---|---|
| `npm run seed-demo -- first-time` | A first visit: nothing answered yet, "Start check 1 of 6" |
| `npm run seed-demo -- part-way` | Two checks done: Next up is Electron arrangement |
| `npm run seed-demo -- returning` | All six topics rated: Next up is Isotopes |

This replaces the student's progress with sample numbers, so only use it for a demo. If it says "Run the app and finish setup first.", start Steady and complete the setup page first.

## Stop Steady

Close the Terminal window that opened when you started Steady (or click in it and press Control-C). Your accounts and progress are kept in the `data` folder and will be there next time.

## For developers

- `npm start` runs the server (port 4600; set `PORT` to change it). Data lives in `data/` (set `STEADY_DATA_DIR` to change it).
- `npm test` runs the tests. There are no npm dependencies to install.
