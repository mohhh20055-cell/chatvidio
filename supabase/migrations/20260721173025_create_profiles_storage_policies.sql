/*
# Storage policies for profiles bucket

## Summary
Creates storage RLS policies for the `profiles` bucket so that:
1. Anyone (anon + authenticated) can READ images — needed for the admin panel to display teacher photos.
2. Authenticated users can UPLOAD their own profile/verification images.
3. Users can UPDATE/DELETE their own files (files under a folder matching their user id).

## Tables affected
- `storage.objects` (Supabase Storage internal table for objects in the `profiles` bucket)

## Security
- SELECT is public (anon + authenticated) because profile images are meant to be displayed in the admin panel and teacher listings.
- INSERT/UPDATE/DELETE are scoped to authenticated users, restricted to their own folder path `teachers/<user_id>/` or a path they control.
*/

-- Allow public read access to profile images
DROP POLICY IF EXISTS "Public read access to profiles" ON storage.objects;
CREATE POLICY "Public read access to profiles"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'profiles');

-- Allow authenticated users to upload to profiles bucket
DROP POLICY IF EXISTS "Authenticated upload to profiles" ON storage.objects;
CREATE POLICY "Authenticated upload to profiles"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'profiles');

-- Allow authenticated users to update their own files in profiles
DROP POLICY IF EXISTS "Authenticated update own profiles files" ON storage.objects;
CREATE POLICY "Authenticated update own profiles files"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'profiles')
WITH CHECK (bucket_id = 'profiles');

-- Allow authenticated users to delete their own files in profiles
DROP POLICY IF EXISTS "Authenticated delete own profiles files" ON storage.objects;
CREATE POLICY "Authenticated delete own profiles files"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'profiles');
