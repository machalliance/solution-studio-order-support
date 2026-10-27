// What one chat message may hold. One place, because the agent enforces it and the storefront has to stop the customer at the
// same number BEFORE they press Send: a limit only the server knew about refused the whole message, text and photos together, and
// the customer had to start it again. No imports: both apps load this file as it is.

export const MAX_PHOTOS_PER_MESSAGE = 4;
