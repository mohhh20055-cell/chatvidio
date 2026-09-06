const axios = require('axios');
const logger = require('./logger');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID || '';

/**
 * Verify Google ID Token (from Google Identity Services / GSI)
 * @param {string} idToken 
 * @returns {Promise<{email: string, name: string, picture: string, sub: string, email_verified: boolean}>}
 */
async function verifyGoogleIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string') {
        throw new Error('رمز تعريف جوجل (ID Token) مفقود أو غير صالح');
    }

    try {
        const response = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
            timeout: 10000
        });

        const data = response.data;
        if (!data || !data.email) {
            throw new Error('لم يتم استرجاع بريد إلكتروني صالح من جوجل');
        }

        // Verify audience matches if client id is configured
        if (data.aud && data.aud !== GOOGLE_CLIENT_ID) {
            logger.warn('Google token aud mismatch:', { aud: data.aud, expected: GOOGLE_CLIENT_ID });
        }

        return {
            email: data.email.toLowerCase().trim(),
            name: data.name || data.given_name || data.email.split('@')[0],
            given_name: data.given_name || '',
            family_name: data.family_name || '',
            picture: data.picture || null,
            sub: data.sub,
            email_verified: data.email_verified === 'true' || data.email_verified === true
        };
    } catch (error) {
        logger.error('Error verifying Google ID token:', error.response?.data || error.message);
        throw new Error(error.response?.data?.error_description || 'فشل التحقق من صحة حساب جوجل');
    }
}

/**
 * Exchange Google OAuth Authorization Code for User Info
 * @param {string} code 
 * @param {string} redirectUri 
 * @returns {Promise<{email: string, name: string, picture: string, sub: string, access_token: string, refresh_token: string}>}
 */
async function exchangeGoogleCode(code, redirectUri) {
    if (!code) {
        throw new Error('رمز تفويض جوجل مفقود');
    }

    try {
        const params = new URLSearchParams();
        params.append('client_id', GOOGLE_CLIENT_ID);
        params.append('client_secret', GOOGLE_CLIENT_SECRET);
        params.append('code', code);
        params.append('grant_type', 'authorization_code');
        params.append('redirect_uri', redirectUri || 'https://www.zoomdz.com/');

        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000
        });

        const { access_token, id_token, refresh_token } = tokenRes.data;

        // Try getting user info from id_token first or userinfo endpoint
        if (id_token) {
            try {
                const idInfo = await verifyGoogleIdToken(id_token);
                return {
                    ...idInfo,
                    access_token,
                    refresh_token: refresh_token || null
                };
            } catch (e) {
                logger.warn('Failed to verify id_token from code exchange, fallback to userinfo:', e.message);
            }
        }

        const userRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${access_token}` },
            timeout: 10000
        });

        const data = userRes.data;
        return {
            email: data.email.toLowerCase().trim(),
            name: data.name || data.given_name || data.email.split('@')[0],
            given_name: data.given_name || '',
            family_name: data.family_name || '',
            picture: data.picture || null,
            sub: data.sub,
            email_verified: data.email_verified === true || data.email_verified === 'true',
            access_token,
            refresh_token: refresh_token || null
        };
    } catch (error) {
        logger.error('Error exchanging Google OAuth code:', error.response?.data || error.message);
        throw new Error(error.response?.data?.error_description || 'فشل استبدال كود التفويض مع جوجل');
    }
}

/**
 * Generate Google OAuth Consent URL
 * @param {string} redirectUri 
 * @param {string} state 
 * @returns {string}
 */
function getGoogleAuthUrl(redirectUri, state = '') {
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri || 'https://www.zoomdz.com/',
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
        state: state
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

module.exports = {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_PROJECT_ID,
    verifyGoogleIdToken,
    exchangeGoogleCode,
    getGoogleAuthUrl
};
