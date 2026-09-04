# Saved logins

Mudlet Web can remember your game passwords so it logs you in automatically. They
are encrypted on this device with a key your browser cannot produce on its own,
and you unlock them once per visit — with a passkey (Touch ID, Windows Hello, your
phone, a security key) or with a passphrase.

The **key icon** at the top of the start screen is where you set this up and where
you manage it afterwards.

## Why not just use your password manager?

Because password managers scope saved logins to a *web address*, and all your
profiles share one. Save logins for ten MUDs and your manager offers all ten,
identically labelled, every time any of them asks — it has no way to tell which
password belongs to which game, because as far as it can see they are all the same
site.

That is the problem this solves, and it decides the whole design: the only thing
your password manager is asked to remember is the **one passphrase that unlocks
Mudlet Web** — a single unambiguous entry — or nothing at all if you use a passkey.
Your game passwords live here instead, encrypted.

The earlier version of this feature simply wrote passwords into browser storage in
plain text, with a warning underneath admitting that was unsafe. Offering a
convenience and then apologising for it is not much of an offer.

## How it works

There is one **master key**, generated randomly on this device. It encrypts your
passwords. Each way of unlocking then wraps its own copy of that master key:

- **A passkey** derives the wrapping key from your authenticator, which releases it
  only after a fingerprint, face, or PIN. Nothing is typed and nothing is stored
  that could be guessed.
- **A passphrase** is stretched into the wrapping key with 600,000 rounds of
  PBKDF2, which is what makes guessing it expensive.

Because they are separate wrappers around the same key, you can have both — and
adding or removing one never touches the passwords themselves.

Unlocking happens once per visit and lives only in memory. Close the tab and the
vault is locked again.

Your **account name** is deliberately *not* encrypted. It isn't a secret, and
keeping it in the clear means the login form can prefill it — which is also what
lets a password manager, if you prefer using one, pick the single matching password
instead of listing every profile's.

## What this protects, and what it doesn't

Encrypting at rest defends against everything that reads storage without running in
the page: disk images, backups, browser sync, someone else using the machine, an
extension trawling your local storage.

It does **not** defend against something running inside the page while the vault is
unlocked — a hostile package, or a cross-site scripting bug. No in-page vault can,
and neither can a password manager with its vault open. If that matters to you,
lock the vault when you are not logging in, or don't save passwords at all.

Saved logins also need a secure page (`https://`, or `localhost`). Over plain
`http://` the browser withholds the cryptography this is built on, and the option
simply won't appear.

## Locking, unlocking, and forgetting

Open a profile that has a saved password and you'll be asked to unlock. Say **Not
now** and nothing is lost — you just type the password yourself that time.

From the key icon you can lock the vault immediately, add a second way in, change
your passphrase, remove an individual saved password, or delete everything.

**There is no password reset, and there cannot be one.** A reset would mean the
passwords could be recovered without your key, which is precisely the property that
makes saving them worthwhile. So if a passphrase is your only way in and you forget
it, those passwords are gone.

What you *can* do is start over. The unlock prompt has a **Forgotten your
passphrase?** link, and the manage view has a delete button; either one discards
the vault and everything in it after confirming, and you can set up saved logins
again straight away. You then re-enter each game password once, at its login
prompt.

The way to avoid that is to add a second way in *before* you need it: a
passphrase-only vault gains a passkey, or a passkey-only vault gains a passphrase,
from the manage view. Two independent ways in means losing one costs you nothing.

## Where it's kept

The encrypted blob lives in this browser's local storage for this address, like the
rest of your data — see [Where your data lives](./storage.md). It is **not**
included when you export profiles: a Mudlet profile export is meant to be moved,
shared and taken to desktop Mudlet, and your passwords have no business travelling
with it. Set up saved logins again on the new machine.
