// Library entry point for branded builds — `import { MudletWebApp } from
// '@mudlet/mudlet-web'`. The standalone app (`main.tsx`) renders the same
// `MudletWebApp` with no brand.
// The CSS side-effect import makes the lib build emit the full stylesheet as
// `styles.css` (consumers `import '@mudlet/mudlet-web/styles.css'`); the './styles.css'
// specifier survives into index.d.ts, where it resolves against the emitted
// file of the same name.
import './styles.css';

// App root + branding (white-label builds)
export { MudletWebApp } from "./MudletWebApp";
export {
    getBrand,
    isBrandedMode,
    isPackageRemovable,
    getThemeChoices,
    isLightTheme,
    DEFAULT_BRAND,
    STOCK_THEMES,
    type BrandConfig,
    type BrandMudTarget,
    type BrandPackage,
    type BrandTheme,
    type BrandCommand,
    type BrandToolbarButton,
    type BrandToolbarConfig,
    type BrandToolbarContext,
    type StockToolbarButton,
    type LandingProps,
} from "./branding";
// `addCommand` for the embedding app: place a command on the toolbar, the menu
// bar or both, and enable, tick or remove it while the client runs.
export { hostCommands as commands } from "./ui/commands/hostCommands";
export type { HostCommand, HostCommandRequest } from "./ui/commands/hostCommands";
// The shapes the `toolbar.menuBar` / `toolbar.buttonBar` transforms are handed.
export type {
    MenuAction, MenuNode, MenuSeparator, MenuSubmenu, PlacedCommand, TopMenu,
} from "./ui/menu/menuModel";
export type {
    ToolbarButtonItem, ToolbarCustomItem, ToolbarItem, ToolbarSplitItem,
} from "./ui/menu/toolbarModel";
export { BrandLoginScreen } from "./ui/BrandLoginScreen";
export { useBrandLogin, type UseBrandLoginResult } from "./ui/useBrandLogin";
export { BrandLoginFields, type BrandLoginFieldsProps } from "./ui/BrandLoginFields";
export { setSessionCredentials, getSessionCredentials, getLastSessionCredentials, type SessionCredentials } from "./utils/sessionCredentials";
export type { MudConnection, ConnectionMode } from "./storage/schema";

// Core
export { EventBus } from "./core/EventBus";

// Scripting
export { ScriptingAPI } from "./scripting/ScriptingAPI";

// MUD session facade
export { MudSession } from "./mud/MudSession";
export type { MudSessionOptions } from "./mud/MudSession";
export type { SessionStatus, MudClientEvents, MudEvents } from "./mud/events";

// Socket / Telnet protocol
export {
    TELNET_OPTION_REGEX,
    GMCP_COMMAND_CODE, GMCP_WILL, GMCP_DO,
    ECHO_WILL, ECHO_WONT, ECHO_DO, ECHO_DONT,
    MCCP2_OPTION,
} from "./mud/protocol/constants";
export { MccpHandler } from "./mud/protocol/mccp";
export { EchoHandler } from "./mud/protocol/echo";
export {
    createTelnetOptionParser,
    stripTelnetSequences,
    createGmcpStream,
    encodeGmcp,
    encodeGmcpRaw,
} from "./mud/protocol/gmcp";
export type { GmcpEnvelope, TelnetOptionHandler, GmcpStreamOptions } from "./mud/protocol/gmcp";

// ANSI / formatting
export {
    AnsiAwareBuffer,
    cloneFormatState,
    formatStatesEqual,
} from "./mud/text/FormatState";
export type {
    FormatStateSnapshot,
    FormatColor,
    IndexedColor,
    RgbColor,
    HexColor,
    FormatHyperlink,
    DimEffect,
    DimEasing,
    BufferSegment,
    TextRange,
} from "./mud/text/FormatState";
export { colorCodes } from "./mud/text/colors";

// Output
export { setupOutputRenderer } from "./ui/output/OutputRenderer";
export type { OutputRendererControls } from "./ui/output/OutputRenderer";

// Client (lower-level API)
export { MudClient } from "./mud/connection/MudClient";
export type { MudClientOptions } from "./mud/connection/MudClient";
export { PingTracker } from "./mud/connection/PingTracker";
export { createPassthroughProcessor } from "./mud/triggers/ChunkProcessor";
export type { ChunkProcessor } from "./mud/triggers/ChunkProcessor";
export { TriggerEngine } from "./mud/triggers/TriggerEngine";
export type { TriggerNode } from "./mud/triggers/TriggerEngine";
