/**
 * Comprehensive QA Integration Tests - January 2026
 * 
 * This test suite validates critical functionality across:
 * - Source utilities and preference handling
 * - API utilities and security functions
 * - Error handling and edge cases
 */

import { 
  sortSourcesByPriority, 
  isPreferredSource, 
  selectBestSource,
  ChapterSource 
} from '../../lib/source-utils';

import {
  sanitizeInput,
  validateEmail,
  validateUsername,
  escapeILikePattern,
  toTitleCase,
  getSafeRedirect,
  isIpInRange,
  parsePaginationParams,
  ApiError,
  ErrorCodes,
} from '../../lib/api-utils';

// ============================================
// Source Utils Tests
// ============================================

describe('Source Utils - sortSourcesByPriority', () => {
  const mockSources = [
    { id: '1', source_name: 'MangaDex', trust_score: 90, chapter_url: 'url1' },
    { id: '2', source_name: 'MangaPark', trust_score: 80, chapter_url: 'url2' },
    { id: '3', source_name: 'MangaSee', trust_score: 85, chapter_url: 'url3' },
  ];

  test('returns sources unchanged when no preferences', () => {
    const sorted = sortSourcesByPriority(mockSources, {});
    // Should fall back to trust score
    expect(sorted[0].source_name).toBe('MangaDex');
    expect(sorted[1].source_name).toBe('MangaSee');
    expect(sorted[2].source_name).toBe('MangaPark');
  });

  test('series preference overrides everything', () => {
    const sorted = sortSourcesByPriority(mockSources, {
      preferredSourceSeries: 'MangaPark',
      preferredSourcePriorities: ['MangaDex', 'MangaSee'],
    });
    expect(sorted[0].source_name).toBe('MangaPark');
  });

  test('global priorities work when no series preference', () => {
    const sorted = sortSourcesByPriority(mockSources, {
      preferredSourceSeries: null,
      preferredSourcePriorities: ['MangaSee', 'MangaPark', 'MangaDex'],
    });
    expect(sorted[0].source_name).toBe('MangaSee');
    expect(sorted[1].source_name).toBe('MangaPark');
    expect(sorted[2].source_name).toBe('MangaDex');
  });

  test('handles empty sources array', () => {
    const sorted = sortSourcesByPriority([], { preferredSourceSeries: 'MangaDex' });
    expect(sorted).toEqual([]);
  });

  test('handles single source', () => {
    const sorted = sortSourcesByPriority([mockSources[0]], { preferredSourceSeries: 'MangaDex' });
    expect(sorted).toHaveLength(1);
    expect(sorted[0].source_name).toBe('MangaDex');
  });
});

describe('Source Utils - isPreferredSource', () => {
  test('identifies series preference correctly', () => {
    const result = isPreferredSource('MangaDex', {
      preferredSourceSeries: 'MangaDex',
      preferredSourcePriorities: ['MangaPark'],
    });
    expect(result.type).toBe('series');
    expect(result.rank).toBe(1);
  });

  test('identifies global priority correctly', () => {
    const result = isPreferredSource('MangaPark', {
      preferredSourceSeries: 'MangaDex',
      preferredSourcePriorities: ['MangaPark', 'MangaSee'],
    });
    expect(result.type).toBe('global');
    expect(result.rank).toBe(1);
  });

  test('returns null for non-preferred source', () => {
    const result = isPreferredSource('UnknownSource', {
      preferredSourceSeries: 'MangaDex',
      preferredSourcePriorities: ['MangaPark'],
    });
    expect(result.type).toBeNull();
    expect(result.rank).toBeNull();
  });
});

describe('Source Utils - selectBestSource', () => {
  const mockSources = [
    { id: '1', source_name: 'MangaDex', trust_score: 90 },
    { id: '2', source_name: 'MangaPark', trust_score: 80 },
    { id: '3', source_name: 'MangaSee', trust_score: 85 },
  ];

  test('selects series preferred source first', () => {
    const result = selectBestSource(mockSources, [], {
      preferredSourceSeries: 'MangaPark',
      preferredSourceGlobal: 'MangaDex',
      preferredSourcePriorities: ['MangaSee'],
    });
    expect(result.source?.source_name).toBe('MangaPark');
    expect(result.reason).toBe('preferred_series');
  });

  test('falls back to priority list when series preferred not found', () => {
    const result = selectBestSource(mockSources, [], {
      preferredSourceSeries: 'NonExistent',
      preferredSourcePriorities: ['MangaSee', 'MangaPark'],
    });
    expect(result.source?.source_name).toBe('MangaSee');
    expect(result.reason).toBe('priority_list');
  });

  test('falls back to trust score when no preferences match', () => {
    const result = selectBestSource(mockSources, [], {
      preferredSourceSeries: 'NonExistent',
      preferredSourcePriorities: [],
    });
    expect(result.source?.source_name).toBe('MangaDex');
    expect(result.reason).toBe('trust_score');
  });

  test('returns null source for empty array', () => {
    const result = selectBestSource([], [], {});
    expect(result.source).toBeNull();
    expect(result.reason).toBe('none');
  });
});

// ============================================
// API Utils Tests
// ============================================

describe('API Utils - sanitizeInput', () => {
  test('removes script tags', () => {
    const input = '<script>alert("xss")</script>Hello';
    expect(sanitizeInput(input)).toBe('Hello');
  });

  test('removes event handlers', () => {
    const input = '<img onerror="alert(1)" src="x">';
    expect(sanitizeInput(input)).not.toContain('onerror');
  });

  test('removes javascript: protocol', () => {
    const input = 'javascript:alert(1)';
    expect(sanitizeInput(input)).not.toContain('javascript:');
  });

  test('respects maxLength parameter', () => {
    const input = 'a'.repeat(100);
    expect(sanitizeInput(input, 50)).toHaveLength(50);
  });

  test('handles null bytes', () => {
    const input = 'hello\x00world';
    expect(sanitizeInput(input)).toBe('helloworld');
  });

  test('handles empty string', () => {
    expect(sanitizeInput('')).toBe('');
  });
});

describe('API Utils - validateEmail', () => {
  test('validates correct email formats', () => {
    expect(validateEmail('test@example.com')).toBe(true);
    expect(validateEmail('user.name+tag@domain.co.uk')).toBe(true);
  });

  test('rejects invalid email formats', () => {
    expect(validateEmail('notanemail')).toBe(false);
    expect(validateEmail('@nodomain.com')).toBe(false);
    expect(validateEmail('spaces in@email.com')).toBe(false);
  });
});

describe('API Utils - validateUsername', () => {
  test('validates correct usernames', () => {
    expect(validateUsername('user123')).toBe(true);
    expect(validateUsername('user_name')).toBe(true);
    expect(validateUsername('user-name')).toBe(true);
  });

  test('rejects invalid usernames', () => {
    expect(validateUsername('ab')).toBe(false); // Too short
    expect(validateUsername('user name')).toBe(false); // Spaces
    expect(validateUsername('user@name')).toBe(false); // Special chars
  });
});

describe('API Utils - escapeILikePattern', () => {
  test('escapes percent signs', () => {
    expect(escapeILikePattern('100%')).toBe('100\\%');
  });

  test('escapes underscores', () => {
    expect(escapeILikePattern('user_name')).toBe('user\\_name');
  });

  test('escapes backslashes', () => {
    expect(escapeILikePattern('path\\to')).toBe('path\\\\to');
  });

  test('handles complex patterns', () => {
    expect(escapeILikePattern('%_\\')).toBe('\\%\\_\\\\');
  });
});

describe('API Utils - getSafeRedirect', () => {
  test('allows internal paths', () => {
    expect(getSafeRedirect('/library')).toBe('/library');
    expect(getSafeRedirect('/series/123')).toBe('/series/123');
  });

  test('blocks protocol-relative URLs', () => {
    expect(getSafeRedirect('//evil.com')).toBe('/library');
  });

  test('returns default for null/undefined', () => {
    expect(getSafeRedirect(null)).toBe('/library');
    expect(getSafeRedirect(undefined)).toBe('/library');
  });

  test('uses custom default', () => {
    expect(getSafeRedirect(null, '/home')).toBe('/home');
  });
});

describe('API Utils - isIpInRange', () => {
  test('validates IP in CIDR range', () => {
    expect(isIpInRange('192.168.1.1', '192.168.1.0/24')).toBe(true);
    expect(isIpInRange('192.168.2.1', '192.168.1.0/24')).toBe(false);
  });

  test('handles /32 (exact match)', () => {
    expect(isIpInRange('127.0.0.1', '127.0.0.1/32')).toBe(true);
    expect(isIpInRange('127.0.0.2', '127.0.0.1/32')).toBe(false);
  });

  test('handles invalid inputs gracefully', () => {
    expect(isIpInRange('invalid', '192.168.1.0/24')).toBe(false);
    expect(isIpInRange('192.168.1.1', 'invalid')).toBe(false);
  });
});

describe('API Utils - parsePaginationParams', () => {
  test('parses default values', () => {
    const params = new URLSearchParams();
    const result = parsePaginationParams(params);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  test('respects limit constraints', () => {
    const params = new URLSearchParams({ limit: '200' });
    const result = parsePaginationParams(params);
    expect(result.limit).toBe(100); // Max capped at 100
  });

  test('calculates offset from page', () => {
    const params = new URLSearchParams({ page: '3', limit: '20' });
    const result = parsePaginationParams(params);
    expect(result.offset).toBe(40);
  });

  test('handles cursor parameter', () => {
    const params = new URLSearchParams({ cursor: 'abc123' });
    const result = parsePaginationParams(params);
    expect(result.cursor).toBe('abc123');
  });
});

describe('API Utils - toTitleCase', () => {
  test('converts kebab-case to Title Case', () => {
    expect(toTitleCase('action-adventure')).toBe('Action Adventure');
  });

  test('handles special genre names', () => {
    expect(toTitleCase('sci-fi')).toBe('Sci-Fi');
    expect(toTitleCase('boys-love')).toBe("Boys' Love");
  });

  test('handles empty string', () => {
    expect(toTitleCase('')).toBe('');
  });
});

describe('API Utils - ApiError', () => {
  test('creates error with correct properties', () => {
    const error = new ApiError('Test error', 400, ErrorCodes.BAD_REQUEST);
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe(ErrorCodes.BAD_REQUEST);
    expect(error.name).toBe('ApiError');
  });

  test('defaults to 500 status code', () => {
    const error = new ApiError('Server error');
    expect(error.statusCode).toBe(500);
  });
});

// ============================================
// Edge Cases and Boundary Tests
// ============================================

describe('Edge Cases', () => {
  test('sortSourcesByPriority handles sources with same trust score', () => {
    const sources = [
      { id: '1', source_name: 'A', trust_score: 85 },
      { id: '2', source_name: 'B', trust_score: 85 },
    ];
    const sorted = sortSourcesByPriority(sources, {});
    expect(sorted).toHaveLength(2);
  });

  test('sanitizeInput handles very long strings', () => {
    const longString = 'a'.repeat(100000);
    const result = sanitizeInput(longString, 1000);
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  test('escapeILikePattern handles Unicode', () => {
    const result = escapeILikePattern('漫画%');
    expect(result).toBe('漫画\\%');
  });

  test('isIpInRange handles edge CIDR values', () => {
    expect(isIpInRange('0.0.0.0', '0.0.0.0/0')).toBe(true);
    expect(isIpInRange('255.255.255.255', '0.0.0.0/0')).toBe(true);
  });
});
