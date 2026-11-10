/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as commands from "../commands.js";
import type * as comments from "../comments.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as images from "../images.js";
import type * as library from "../library.js";
import type * as nodes from "../nodes.js";
import type * as oauth from "../oauth.js";
import type * as pages from "../pages.js";
import type * as presence from "../presence.js";
import type * as projects from "../projects.js";
import type * as sharing from "../sharing.js";
import type * as styles from "../styles.js";
import type * as tokens from "../tokens.js";
import type * as users from "../users.js";
import type * as versions from "../versions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  commands: typeof commands;
  comments: typeof comments;
  files: typeof files;
  http: typeof http;
  images: typeof images;
  library: typeof library;
  nodes: typeof nodes;
  oauth: typeof oauth;
  pages: typeof pages;
  presence: typeof presence;
  projects: typeof projects;
  sharing: typeof sharing;
  styles: typeof styles;
  tokens: typeof tokens;
  users: typeof users;
  versions: typeof versions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
