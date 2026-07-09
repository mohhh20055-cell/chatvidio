// ============================================================
// دوال مساعدة عامة
// ============================================================

const { supabase } = require('../config/database');
const crypto = require('crypto');

function sanitizeInput(input) {
    if (typeof input === 'string') {
        return input.trim();
    }
    return input;
}

function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            sanitized[key] = sanitizeInput(value);
        } else if (Array.isArray(value)) {
            sanitized[key] = value.map(v => typeof v === 'string' ? sanitizeInput(v) : v);
        } else if (value && typeof value === 'object') {
            sanitized[key] = sanitizeObject(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateReferralCode(name, id) {
    const prefix = name.substring(0, 3).toUpperCase();
    const suffix = id.toString(36).toUpperCase();
    return `${prefix}${suffix}`;
}

async function getOne(table, column, value) {
    try {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .eq(column, value)
            .single();
        if (error && error.code !== 'PGRST116') return null;
        return data;
    } catch (error) {
        console.error('خطأ في getOne:', error.message);
        return null;
    }
}

async function insert(table, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).insert(sanitizedData).select();
        if (error) throw error;
        return result[0];
    } catch (error) {
        console.error(`خطأ في insert إلى ${table}:`, error.message);
        throw error;
    }
}

async function update(table, id, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).update(sanitizedData).eq('id', id).select();
        if (error) throw error;
        return result[0];
    } catch (error) {
        console.error(`خطأ في update للجدول ${table}:`, error.message);
        throw error;
    }
}

async function remove(table, column, value) {
    try {
        const { error } = await supabase.from(table).delete().eq(column, value);
        if (error) throw error;
        return true;
    } catch (error) {
        console.error(`خطأ في remove من ${table}:`, error.message);
        throw error;
    }
}

module.exports = {
    sanitizeInput,
    sanitizeObject,
    generateVerificationToken,
    generateReferralCode,
    getOne,
    insert,
    update,
    remove
};
