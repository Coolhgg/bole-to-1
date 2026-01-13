export const READING_SOURCE_HOSTS = [
  'mangadex.org',
  'mangapark.net',
  'mangapark.me', 
  'mangapark.com',
  'mangasee123.com',
  'manga4life.com',
  'comick.io',
  'comick.app',
];

export const CANONICAL_HOSTS = [
  'mangadex.org',
  'anilist.co',
  'myanimelist.net',
];

export function getSourceFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    if (host.includes('mangadex.org')) return 'MangaDex';
    if (host.includes('mangapark')) return 'MangaPark';
    if (host.includes('mangasee')) return 'MangaSee';
    if (host.includes('manga4life')) return 'Manga4Life';
    if (host.includes('comick')) return 'Comick';
    if (host.includes('anilist.co')) return 'AniList';
    if (host.includes('myanimelist.net')) return 'MyAnimeList';
    return null;
  } catch {
    return null;
  }
}
