# @aphorica/server-event-mgr

Implements a server-event service in node _Express_.

See also:
 - [@aphorica/server-event-client][1] - client-side class for invoking
   this via rest api.
 - [server-event-demo][2] - docker-compose file that sets up
   a development environment to test/demo.

Implements a server-event service in node express.

## Overview
Server Events are a tentatively simpler, less resource intensive
one-way notification mechanism (than web sockets) for the server to notify the client when something happens.

However, there are complications - the server app must associate
the response with the requesting client and retain it so it can
use the response for subsequent notifications.

This leads to issues:
 - Clients that drop - the drop is undetectable by the server,
   so you get an increasingly large collection of dead
   client/response entries.
 - You don't want to arbitrarily remove entries _willy-nilly_
   because you'll likely delete an entry that is active and
   waiting to send a notification.

To address this, the manager stores a timestamp with each
registration invocation.  Entries with a timestamp that exceeds
a threshold is considered dead and removed on the next cleanup
pass.

To prevent active connections going stale, the client sends _keep-alive_ requests on regular intervals (part of the client
_EventSource_ implementation.)  This request
reinvokes the client registration mechanism in the server, with
the original id. 
In that invocation, a new timestamp and the new response are
replaced in the entry, and the entry remains in the active list.

### Multiple Clients With Same User
If the user has several open clients, a notification needs to
go to all the clients for that user.  This is accomplished during the `notifyCompletions` call by searching the connections entries
for any that are prefixed with the `name` argument supplied during registration.

Any name prefixed entries will then get sent the notification.

(May want to tune this in the future, or set it as an option of
the submission request).

## Features:
 - provides rest endpoints for operations
 - provides a singleton 'manager' object that actually performs
   the operations.  You can either allow the express
   rest calls provided (which will use the object, internally), 
   or you can provide your own rest calls and invoke the operations
   on the manager object.
 - keeps a list of connections - these are used to send
   messages when a task is completed.
 - the list is periodically scanned for dormant connections.  Those
   inactive for a specific timeout threshold are cleaned up.
 - you can provide a prefix to the built-in rest points.  The
   default prefix is '/sse/'

## Caveats:
 - _IN PROGRESS - STILL DEVELOPING_
  - (pull requests welcome.)
 - Currently does not support multiple managers. Could think
   about that, if required.
 - If the client drops, there is no way for the server to know that
   happened.  Consequently, when the client comes back, its id is
   invalid.  Active re-connection by the client (get a new id and
   re-register) will resume any currently registered tasks.

## Implementation Notes:
### Instantiated Router
The manager creates a router via the `createRouter()` function,
which is returned from that call.  The router needs to be added
to the _Express_ app:
```
const ServerEventMgr = require('@aph/server-event-mgr');
app.use(ServerEventMgr.createRouter());
```
If you provide your own rest handlers, you do not need to
create the router (untested).
### Express Global Request Handlers
A typical _Express_ app will have a global request handler to
set things like response headers, especially CORS headers.

SSE responses require their own headers.  If you have implemented
a global request handler to provide headers, you must qualify the
request to not send headers when the rest path includes
`/register-listener/`.

An example from the test/demo package follow (I use semi-colons):

```
var allowCrossDomain = function(req, res, next) {
  console.log('allowXDomain: ' + req.method +
  ' ' + req.path);
  if (req.path.indexOf('/register-listener/') === -1) {
            // do NOT do following if registering listener
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Content-Length, X-Requested-With');
    // intercept OPTIONS method
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
  }

  next();
};
```

SSE responses include a CORS header for '*' (Might could make this
a settable feature, if desired);
### "/submit-task" Rest Endpoint
The `/submit-task` rest endpoint is provided by you.  In this
endpoint, you will perform the task necessary, and at the end of
the task, you will invoke the manager `notifyCompletions()` function
with the client id (provided earlier) and a task id.

The method of the endpoint is entirely up to the you - it can
be a __PUT__, __GET__, __POST__, or whatever.

## Rest API
The provided rest endpoints are listed, along with their corresponding
manager calls.  See the _ServerEventManager_ API for operational details.

### Main API
 - `(pfx)/make-id/:name` => `getUniqueID(name)`
 - `(pfx)/register-listener/:id` => `registerListener(id, response)`
 - `(pfx)/disconnect-registrant/:id` => `unregisterListener(id)`

### Provided By Implementor (you)
 - `/submit-task/:id/:taskid` => (ultimately) `notifyCompletions(id, taskid)`

### Debugging 
 - `(pfx)/list-registrants` => `getListenersJSON()`
 - `(pfx)/clear-registrants` => `unregisterAllListeners()`
 - `(pfx)/trigger-adhoc/:id` => `triggerAdHocResponse(id)`
 - `(pfx)/trigger-cleanup` => `triggerCleanup()`

## Manager API
### Setup API
<dl>
<dt>createRouter(prefix)</dt>
<dd>
<em>prefix</em> - the prefix to apply (default: '/sse/')<br/>
returns - a new router<br/><br/>
The prefix will be prepended to all publicly exposed urls
in the router.  If not provided, the default ('/sse/') will
be used.

The returned router must be 'added' to the _Express_ app by the
caller.
</dd>
<dt>setVerbose(flag)</dt>
<dd>
<em>flag</em> - true/false<br/><br/>
If set, will log diagnostic messages.  Used for debugging.</dd>
<dt>setNotifyListenersChanged(flag) - (experimental)</dt>
<dd>
<em>flag</em> - true/false<br/><br/>
If set, when users are added or removed, all listeners will be
notified of the change.  Mainly for debugging, but might be
useful in other contexts.</dd>
</dl>

### Main API
<dl>
<dt>getUniqueID(name)</dt>
<dd>
<em>name</em> - typically a username<br/>
returns - the unique id<br/><br/>
Constructs a unique id based on the provided name, in the form
`name_xxxxx` where 'x' represents an alphanum character.  The
resultant id is used for all subsequent operations that require
an id.</dd>
<dt>isRegistered(id)</dt>
<dd>
<em>id</em> - the unique id for this listener<br/>
returns - whether or not the id is registered<br/><br/>
Query if the id is in the list of active connections.</dd>
<dt>registerListener(id, response)</dt>
<dd>
<em>id</em> - the unique id for this listener<br/>
<em>response</em> - the original response object passed in the
      request.<br/><br/>
The response object is associated with this id and held.  It is
used to transmit subsequent notifications to the client(s)
associated with this ID.</dd>
<dt>unregisterListener(id)</dt>
<dd>
<em>id</em> - the unique id for this listener<br/><br/>
The listener is removed from the list of active connections and
the response is nulled deleted.  No other actions occur.</dd>
<dt>notifyCompletions(id, taskid)</dt>
<dd>
<em>id</em> - the unique id for this listener<br/>
<em>taskid</em> - a task-specific id provided by the client<br/><br/>
Called by the implementor when a specific task is completed after
submission (from the client.)  The taskid is returned to the client in the notification.</dd>
</dl>

### Debugging API
<dl>
<dt>getListenersJSON()</dt>
<dd>
returns - a JSON of all the listeners as a map<br/><br/>
Used mainly for debugging</dd>
<dt>unregisterAllListeners()</dt>
<dd>
Removes and deletes all listener entries.  Also
turns off the cleanupInterval mechanism.</dd>
<dt>notifyListenersChanged() - (experimental)</dt>
<dd>
Will send change notification to all listeners.</dd>
<dt>triggerAdHocResponse(id)</dt>
<dd>
<em>id</em> - the unique id for this listener<br/><br/>
Forces the server to send a notification.</dd>
<dd>
<dt>triggerCleanup()</dt>
<dd>
Forces an immediate invocation of the cleanup mechanism.</dd>
</dl>
[1]:https://www.npmjs.com/package/@aphorica/server-event-client
[2]:https://github.com/Aphorica/server-event-demo
