# Sara Public Interview Booking

Sara is a controlled invitation, booking, confirmation, reminder, and help workflow. It does not use AI and never writes to Command Leads, People, Actions, or Meetings.

## Candidate flow

1. An administrator imports candidates and explicitly selects up to 50.
2. `startSaraOutreach` sends the editable `invitationMessage` containing `{{bookingPageUrl}}`.
3. The candidate opens the unauthenticated FlutterFlow route `publicInterview`.
4. The page loads approved content and live availability through public callables.
5. The candidate selects a slot, enters their name and phone, accepts SMS consent, and books.
6. The transaction reserves capacity, creates `saraInterviews`, sends confirmation, and schedules the reminder.

## Public callables

- `getPublicInterviewPage`
- `getPublicInterviewAvailability`
- `bookPublicInterview`

They do not require Firebase Authentication and never expose Firestore directly. Public booking is protected by input validation, a honeypot, phone/IP rate limiting, duplicate booking detection, live availability revalidation, and a transactional capacity reservation.

## Admin callables

- `getSaraDashboard`
- `saveSaraSettings`
- `updateSaraCandidate`
- `importSaraCandidates`
- `startSaraOutreach`
- `getSaraConversation`
- `sendSaraManualReply`
- `setSaraConversationControl`
- `getSaraAvailability`
- `listSaraInterviews`
- `updateSaraInterviewOutcome`
- `recordSaraConsent`
- `saveSaraAvailabilityBlock`
- `deleteSaraAvailabilityBlock`
- `listSaraAvailabilityBlocks`
- `getSaraSystemHealth`

## Inbound SMS

- STOP and standard opt-out keywords immediately stop outreach.
- HELP sends the configured help response.
- Other messages enter Human Help and receive at most one acknowledgement every 12 hours.
- There is no AI interpretation, message buffering, automatic screening, time selection, or automated follow-up conversation.

## FlutterFlow

The existing page is named `publicInterview`. It must not require authentication, read Firestore, or depend on `currentUser`. It calls only the three public functions.

## Deployment

Deploy only the changed Sara functions. Delete the retired Firestore trigger after the replacement is live:

```bash
firebase functions:delete processSaraInboundMessage --region northamerica-northeast1
```

Do not deploy Firestore rules. No Firestore rule changes are required.
