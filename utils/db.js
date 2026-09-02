const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

let supabase;

if (!supabaseUrl || !supabaseKey) {
    logger.warn('[AI Studio] Supabase credentials missing — using mock client in utils/db.js');
    const asyncNoOp = async () => ({ data: null, error: null });
    const asyncInsertNoOp = async () => ({ data: [{ id: 123 }], error: null });
    const mockClient = {
        from: () => ({
            select: () => ({
                eq: () => ({
                    single: asyncNoOp,
                    order: () => ({ single: asyncNoOp, select: asyncNoOp }),
                    in: () => ({ single: asyncNoOp, order: () => ({ single: asyncNoOp }) }),
                }),
                single: asyncNoOp,
                order: () => ({ single: asyncNoOp, limit: () => ({ single: asyncNoOp }) }),
                limit: () => ({ single: asyncNoOp }),
            }),
            insert: () => ({ select: asyncInsertNoOp }),
            update: () => ({ eq: () => ({ select: asyncInsertNoOp }) }),
            delete: () => ({ eq: asyncNoOp }),
            upsert: () => ({ select: asyncInsertNoOp }),
        }),
        auth: {
            getUser: asyncNoOp,
            signInWithPassword: asyncNoOp,
            signOut: asyncNoOp,
        },
        storage: {
            from: () => ({
                upload: asyncNoOp,
                getPublicUrl: () => ({ data: { publicUrl: '' } }),
                remove: asyncNoOp,
            }),
        }
    };
    supabase = new Proxy(mockClient, {
        get: (target, prop) => {
            if (prop in target) return target[prop];
            return () => mockClient;
        }
    });
} else {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
    } catch (e) {
        logger.warn('[AI Studio] Failed to initialize Supabase in utils/db.js — using mock client', { error: e.message });
        supabase = new Proxy({}, { get: () => () => ({ data: null, error: null }) });
    }
}

function sanitizeInput(input) {
    if (typeof input === 'string') {
        return input.trim();
    }
    return input;
}

function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object' || Buffer.isBuffer(obj) || obj instanceof Date) return obj;
    
    if (Array.isArray(obj)) {
        return obj.map(v => typeof v === 'string' ? sanitizeInput(v) : sanitizeObject(v));
    }
    
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            sanitized[key] = sanitizeInput(value);
        } else if (typeof value === 'object' && value !== null) {
            sanitized[key] = sanitizeObject(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

async function getOne(table, column, value) {
    try {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .eq(column, value)
            .single();
        if (error && error.code !== 'PGRST116') {
            logger.error(`خطأ في getOne من جدول ${table}`, { 
                table, 
                column, 
                value,
                error: error.message 
            });
            return null;
        }
        return data;
    } catch (error) {
        logger.error(`استثناء في getOne من جدول ${table}`, { 
            table, 
            column, 
            error: error.message,
            stack: error.stack 
        });
        return null;
    }
}

async function insert(table, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).insert(sanitizedData).select();
        if (error) {
            logger.error(`خطأ في insert إلى جدول ${table}`, { 
                table, 
                data: sanitizedData,
                error: error.message 
            });
            throw error;
        }

        if (!result || result.length === 0) {
            logger.error(`فشل إدخال البيانات في جدول ${table} - لا توجد نتائج`, { table, data: sanitizedData });
            return null;
        }

        logger.debug(`تم إدخال بيانات في جدول ${table}`, { table, insertedId: result?.[0]?.id });
        return result[0];
    } catch (error) {
        logger.error(`استثناء في insert إلى جدول ${table}`, { 
            table, 
            error: error.message,
            stack: error.stack 
        });
        throw error;
    }
}

async function update(table, id, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).update(sanitizedData).eq('id', id).select();

        if (error) {
            logger.error(`خطأ في update لجدول ${table}`, { 
                table, 
                id, 
                data: sanitizedData,
                error: error.message 
            });
            throw error;
        }

        if (!result || result.length === 0) {
            logger.warn(`لم يتم العثور على سجل لتحديثه في جدول ${table}`, { id });
            return null;
        }

        logger.debug(`تم تحديث بيانات في جدول ${table}`, { table, id });
        return result[0];
    } catch (error) {
        logger.error(`استثناء في update لجدول ${table}`, { 
            table, 
            id, 
            error: error.message,
            stack: error.stack 
        });
        throw error;
    }
}

async function updateWithCondition(table, id, expectedBalanceField, expectedBalanceValue, data) {
    try {
        const sanitizedData = sanitizeObject(data);
        const { data: result, error } = await supabase.from(table).update(sanitizedData).eq('id', id).eq(expectedBalanceField, expectedBalanceValue).select();

        if (error) {
            logger.error(`خطأ في updateWithCondition لجدول ${table}`, { 
                table, id, data: sanitizedData, error: error.message 
            });
            throw error;
        }

        if (!result || result.length === 0) {
            return null; // Condition not met or record not found
        }

        return result[0];
    } catch (error) {
        throw error;
    }
}

async function remove(table, column, value) {
    try {
        const { error } = await supabase.from(table).delete().eq(column, value);
        if (error) {
            logger.error(`خطأ في remove من جدول ${table}`, { 
                table, 
                column, 
                value,
                error: error.message 
            });
            throw error;
        }
        return true;
    } catch (error) {
        logger.error(`استثناء في remove من جدول ${table}`, { 
            table, 
            column, 
            value,
            error: error.message,
            stack: error.stack 
        });
        throw error;
    }
}

module.exports = { supabase, getOne, insert, update, updateWithCondition, remove, sanitizeObject };
