/// <reference types="astro/client" />

type AuthUser = import('better-auth').User & {
  role?: string | null;
  banned?: boolean | null;
};

declare namespace App {
  interface Locals {
    user: AuthUser | null;
  }
}
