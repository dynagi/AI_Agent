export type MemoryType = 'Note' | 'Link' | 'File' | 'Image' | 'Video' | 'Voice' | 'Idea' | 'Document' | 'Travel';
export type MemoryCategory = 'Work / Career' | 'Personal' | 'Ideas' | 'Projects' | 'Travel' | 'Finance' | 'Health & Wellness' | 'Learning' | 'Others';

export interface Memory {
  id: string; title: string; body: string; type: MemoryType; category: MemoryCategory; ts: string;
  favorite: boolean; deleted?: boolean; image?: string; bullets?: string[]; checks?: string[];
}

export const memoryCategories: MemoryCategory[] = ['Work / Career', 'Personal', 'Ideas', 'Projects', 'Travel', 'Finance', 'Health & Wellness', 'Learning', 'Others'];
