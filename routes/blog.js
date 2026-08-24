const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const logger = require('../utils/logger');

// Helper function to format Imgur URLs into direct image links
function formatImgurUrl(url) {
    if (!url || typeof url !== 'string') return '';
    let trimmed = url.trim();
    if (!trimmed) return '';

    // If protocol is missing, prepend https://
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        if (trimmed.includes('imgur.com')) {
            trimmed = 'https://' + trimmed;
        }
    }

    // Strip query parameters and hashes
    trimmed = trimmed.split('?')[0].split('#')[0];

    // Handle Imgur URLs
    if (trimmed.includes('imgur.com')) {
        // Direct i.imgur.com link
        if (trimmed.includes('i.imgur.com')) {
            if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(trimmed)) {
                trimmed += '.png';
            }
            return trimmed;
        }

        // Match gallery, album, or direct image hash
        const match = trimmed.match(/imgur\.com\/(?:a\/|gallery\/|r\/[a-zA-Z0-9_-]+\/)?([a-zA-Z0-9]+)/i);
        if (match && match[1]) {
            return `https://i.imgur.com/${match[1]}.png`;
        }
    }
    return trimmed;
}

// Get all published blog posts
router.get('/blogs', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('blogs')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            if (error.code === '42P01') {
                return res.json({ success: true, blogs: [] });
            }
            throw error;
        }

        res.json({ success: true, blogs: data || [] });
    } catch (e) {
        logger.error('Error fetching blogs:', e);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get single blog post by slug or id
router.get('/blogs/:identifier', async (req, res) => {
    try {
        const identifier = decodeURIComponent(req.params.identifier);
        
        let { data, error } = await supabase
            .from('blogs')
            .select('*')
            .eq('slug', identifier)
            .maybeSingle();

        if (!data && !isNaN(identifier) && Number.isInteger(Number(identifier))) {
            const idRes = await supabase
                .from('blogs')
                .select('*')
                .eq('id', parseInt(identifier))
                .maybeSingle();
            data = idRes.data;
            error = idRes.error;
        }

        if (error || !data) {
            return res.status(404).json({ success: false, error: 'المقال غير موجود' });
        }

        res.json({ success: true, blog: data });
    } catch (e) {
        logger.error('Error fetching single blog:', e);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Admin: Create blog post
router.post('/admin/blogs', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { title, slug, excerpt, content, cover_image, seo_keywords, meta_description, author } = req.body;

        if (!title || !content) {
            return res.status(400).json({ success: false, error: 'العنوان ومحتوى المقال مطلوبان' });
        }

        const formattedCoverImage = formatImgurUrl(cover_image);
        const finalSlug = slug ? slug.trim().toLowerCase().replace(/\s+/g, '-') : title.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

        const newBlog = {
            title,
            slug: finalSlug,
            excerpt: excerpt || '',
            content,
            cover_image: formattedCoverImage,
            seo_keywords: seo_keywords || '',
            meta_description: meta_description || excerpt || '',
            author: author || 'إدارة ZoomDz',
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('blogs')
            .insert([newBlog])
            .select()
            .single();

        if (error) {
            if (error.code === '42P01') {
                return res.status(400).json({ success: false, error: 'جدول المقالات (blogs) غير موجود في قاعدة البيانات' });
            }
            throw error;
        }

        res.json({ success: true, blog: data });
    } catch (e) {
        logger.error('Error creating blog:', e);
        res.status(500).json({ success: false, error: e.message || 'Internal server error' });
    }
});

// Admin: Update existing blog post
router.put('/admin/blogs/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const blogId = req.params.id;
        const { title, slug, excerpt, content, cover_image, seo_keywords, meta_description, author } = req.body;

        if (!title || !content) {
            return res.status(400).json({ success: false, error: 'العنوان ومحتوى المقال مطلوبان' });
        }

        const formattedCoverImage = formatImgurUrl(cover_image);
        const finalSlug = slug ? slug.trim().toLowerCase().replace(/\s+/g, '-') : title.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

        const updatedData = {
            title,
            slug: finalSlug,
            excerpt: excerpt || '',
            content,
            cover_image: formattedCoverImage,
            seo_keywords: seo_keywords || '',
            meta_description: meta_description || excerpt || '',
            updated_at: new Date().toISOString()
        };

        if (author) updatedData.author = author;

        const { data, error } = await supabase
            .from('blogs')
            .update(updatedData)
            .eq('id', blogId)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, blog: data, message: 'تم تحديث المقال بنجاح' });
    } catch (e) {
        logger.error('Error updating blog:', e);
        res.status(500).json({ success: false, error: e.message || 'Internal server error' });
    }
});

// Admin: Delete blog post
router.delete('/admin/blogs/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const blogId = req.params.id;
        const { error } = await supabase
            .from('blogs')
            .delete()
            .eq('id', blogId);

        if (error) throw error;

        res.json({ success: true, message: 'تم حذف المقال بنجاح' });
    } catch (e) {
        logger.error('Error deleting blog:', e);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
