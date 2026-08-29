const logger = require('./logger');
const webpush = require('web-push');

webpush.setVapidDetails(
    'mailto:hamodi20052@gmail.com',
    'BB1Dcbh6jxa4PZCvCWX0-fq-MQD2SjeKq2uworSRnKmTRIiFhZlPsan1waIPDY3tjhxqaK_7Ww7rj2Ymmr3AF9w',
    'Ee2Xf4Ftxaxo_65RXaLZAMn8IioJFyZpUU615LZgbT0'
);

async function sendPushNotification(user, title, body) {
    if (!user || !user.push_subscription) return;
    
    try {
        const subscription = JSON.parse(user.push_subscription);
        const payload = JSON.stringify({ title, body });
        await webpush.sendNotification(subscription, payload);
        console.log('✅ تم إرسال إشعار الدفع بنجاح');
    } catch (e) {
        logger.error('❌ خطأ في إرسال إشعار الدفع:', e);
    }
}

module.exports = { sendPushNotification };
