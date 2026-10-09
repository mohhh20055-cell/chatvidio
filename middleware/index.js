// middleware/index.js
const auth = require('./auth');

// إعادة تصدير كل الدوال
module.exports = {
    authenticate: auth.authenticate,
    authorize: auth.authorize,
    checkBanned: auth.checkBanned,
    checkActiveStream: auth.checkActiveStream,
    validateOfferOwnership: auth.validateOfferOwnership,
    validateStudentAccess: auth.validateStudentAccess,
    checkStreamActive: auth.checkStreamActive,
    checkNoActiveStream: auth.checkNoActiveStream,
    checkStudentInStream: auth.checkStudentInStream,
    isOwner: auth.isOwner
};
