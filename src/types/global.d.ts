import type { DadApi } from '../../shared/types';

declare global {
  interface Window {
    dad: DadApi;
  }
}

export {};
