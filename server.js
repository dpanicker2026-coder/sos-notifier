/**
 * FamLoc SOS Notifier — Render worker service
 *
 * Runs a lightweight loop (every CHECK_INTERVAL_MS) that scans all groups'
 * /sos nodes for active alerts nobody has been notified about yet, and
 * sends FCM push notifications to every other member in that alert's group.
 *
 * This exists independently of the app's own background location task, so
 * SOS delivery survives the app being killed/backgrounded on the sender's
 * OR recipient's phone (recipients just need internet + Play Services,
 * same as any push notification from WhatsApp/Telegram/etc).
 *
 * "Already notified" state is stored directly on the alert node in Firebase
 * itself (a `notified: true` field), so no separate database/KV is needed.
 *
 * Required environment variables (set in Render's dashboard, not committed):
 *   - FIREBASE_SERVICE_ACCOUNT_JSON  (paste the full contents of serviceAccountKey.json)
 *   - FIREBASE_DB_URL                (e.g. https://famloc-16903-default-rtdb.asia-southeast1.firebasedatabase.app)
 */

const http = require('http');
const admin = require('firebase-admin');

const CHECK_INTERVAL_MS = 30 * 1000; // comfortably inside the 60s target
const PORT = process.env.PORT || 3000;

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

async function checkAndNotify() {
  try {
    const groupsSnap = await db.ref('/groups').once('value');
    const groups = groupsSnap.val() || {};

    for (const [groupId, group] of Object.entries(groups)) {
      const sosAlerts = group.sos || {};
      const members = group.members || {};

      const pendingAlerts = Object.entries(sosAlerts).filter(
        ([, alert]) => alert && alert.active && !alert.notified
      );
      if (pendingAlerts.length === 0) continue;

      for (const [alertId, alert] of pendingAlerts) {
        const recipients = Object.entries(members)
          .filter(([memberId, m]) => memberId !== alert.memberId && m && m.fcmToken)
          .map(([, m]) => m.fcmToken);

        if (recipients.length === 0) {
          console.log(`No recipients with fcmToken for alert ${alertId} in group ${groupId}`);
        } else {
          const response = await admin.messaging().sendEachForMulticast({
            tokens: recipients,
            notification: {
              title: `🆘 SOS from ${alert.name || 'a family member'}`,
              body: 'Tap to open FamLoc and see their location.',
            },
            data: { type: 'sos', alertId },
            android: {
              priority: 'high', // CRITICAL: high priority to break through Doze mode
              notification: { 
                channelId: 'sos-alerts', 
                sound: 'default',
                color: '#FF0000',
                priority: 'max',
              },
            },
            apns: {
              payload: {
                aps: {
                  'content-available': 1,
                  alert: {
                    title: `🆘 SOS from ${alert.name || 'a family member'}`,
                    body: 'Tap to open FamLoc and see their location.',
                  },
                  sound: 'default',
                },
              },
            },
          });
          console.log(
            `Alert ${alertId} (group ${groupId}): ${response.successCount}/${recipients.length} delivered`
          );
        }

        // Mark as notified regardless of delivery success/failure per token —
        // avoids infinite retry storms on a permanently-dead token. Delivery
        // failures are logged above for manual follow-up if needed.
        await db.ref(`/groups/${groupId}/sos/${alertId}`).update({ notified: true });
      }
    }
  } catch (err) {
    console.log('SOS check failed:', err.message);
  }
}

// Lightweight HTTP server — mainly exists so an external uptime pinger can
// hit `/health` periodically to prevent Render's free-tier services from
// spinning down after 15 minutes of no incoming requests. The interval
// loop below only keeps running while the process itself is alive, so this
// endpoint is what makes that possible on the free tier.
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('FamLoc SOS notifier is running');
  })
  .listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}`);
  });

console.log(`Starting SOS check loop, every ${CHECK_INTERVAL_MS / 1000}s`);
checkAndNotify();
setInterval(checkAndNotify, CHECK_INTERVAL_MS);