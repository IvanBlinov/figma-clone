/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as commands from "../commands.js";
import type * as comments from "../comments.js";
import type * as files from "../files.js";
import type * as images from "../images.js";
import type * as library from "../library.js";
import type * as nodes from "../nodes.js";
import type * as pages from "../pages.js";
import type * as presence from "../presence.js";
import type * as projects from "../projects.js";
import type * as styles from "../styles.js";
import type * as versions from "../versions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  commands: typeof commands;
  comments: typeof comments;
  files: typeof files;
  images: typeof images;
  library: typeof library;
  nodes: typeof nodes;
  pages: typeof pages;
  presence: typeof presence;
  projects: typeof projects;
  styles: typeof styles;
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
