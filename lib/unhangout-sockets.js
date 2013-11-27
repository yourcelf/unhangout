var RoomManager = require("./room-manager").RoomManager,
    _ = require("underscore"),
    events = require("events"),
    models = require("./server-models"),
    sockjs_lib = require("sockjs"),
    logger = require("./logging").getLogger();


function UnhangoutSocketManager(httpServer, db, options) {
    this.httpServer = httpServer;
    this.db = db;
    this.options = options;
    _.bindAll(this, "init", "shutdown", "getEvent");

}
_.extend(UnhangoutSocketManager.prototype, events.EventEmitter.prototype, {
    init: function(sockjs) {
        var sockjs = sockjs_lib.createServer({
            log: function(severity, message) {
                logger.log("debug", severity + ": " + message);
            },
            disconnect_delay: this.options.disconnect_delay
        });
        sockjs.installHandlers(this.httpServer, {prefix: '/sock'});
        this.sockjs = sockjs;
        var mgr = new RoomManager(sockjs, this.db.users);
        this.mgr = mgr;
        // Default authentication (permissive) for "event/" namespace.
        mgr.channelAuth.event = mgr.channelAuth[""];
        // Default authentication (permissive) for "session/" namespace.
        mgr.channelAuth.session = mgr.channelAuth[""];

        mgr.on("join", _.bind(function(socket, args) {
            var channel = args.roomId.split("/")[0];
            if (channel == "event") {
                var event = this.getEvent(args.roomId);
                logger.info("user:" + socket.user.id + " joining event:" + event.id);

                event.get("recentMessages").each(function(message) {
                    var obj = message.toJSON();
                    mgr.writeData(socket, "chat", obj);
                });
                if (args.userFirst) {
                    mgr.broadcast(args.roomId, "join", {
                        id: event.id, user: socket.user.toJSON(), roomId: args.roomId
                    });
                    // TODO: consider whether we can avoid persisting a list of
                    // users in `event`, rather than just using the list that's
                    // already in RoomManager. When sending initial data to the
                    // client, we'd have to pull it from RoomManager..
                    event.get("connectedUsers").set(mgr.roomToUsers[args.roomId]);
                    event.userConnected(socket.user);
                }
                logger.debug("connected users: " + JSON.stringify(event.get("connectedUsers").pluck("displayName")));
            } else if (channel == "session" && args.userFirst) {
                var session = this.getSession(args.roomId);
                if (!session) {
                    logger.warn("Attempt to join room for unknown session", args.roomId);
                    return;
                }
                logger.info("user:" + socket.user.id + " joining session:" + session.id);
                if (args.roomFirst) {
                    session.set("hangoutConnected", true);
                }
                if (session.addConnectedParticipant(socket.user.toJSON())) {
                    session.save();
                }
            }
        }, this));

        mgr.on("leave", _.bind(function(socket, args) {
            var channel = args.roomId.split("/")[0];
            if (channel == "event" && args.userLast) {
                var event = this.getEvent(args.roomId);
                logger.info("user:" + socket.user.id + " leaving event:" + event.id);
                mgr.broadcast(args.roomId, "leave", {
                    id: event.id, user: socket.user.toJSON(), roomId: args.roomId
                });
                event.get("connectedUsers").remove(socket.user);
            } else if (channel == "session" && args.userLast) {
                var session = this.getSession(args.roomId);
                logger.info("user:" + socket.user.id + " leaving session:" + session.id);
                session.removeConnectedParticipant(socket.user);
                if (args.roomLast) {
                    session.set("hangoutConnected", false);
                }
                session.save();
            }
        }, this));

        //
        // Event rooms
        //
        mgr.on("chat", _.bind(function(socket, args) {
            if (!("text" in args)) {
                return mgr.writeErr(socket, "chat", "missing text in chat message");
            }
            var event = this.getEvent(args.roomId);
            if (event && socket.user && mgr.roomContainsSocket(args.roomId, socket)) {
                var msg = new models.ServerChatMessage({
                    user: socket.user,
                    text: args.text
                });
                event.get("recentMessages").push(msg);
                // TODO: Put roomId in broadcast? Can a socket be in more than one room?
                mgr.broadcast(args.roomId, "chat", msg.toJSON());
                mgr.writeAck(socket, "chat");
            } else {
                mgr.writeErr(socket, "chat", "Unknown room");
            }
        }, this));
        mgr.on("blur", _.bind(function(socket, args) {
            var event = this.getEvent(args.roomId);
            if (event && socket.user && mgr.roomContainsSocket(args.roomId, socket)) {
                mgr.broadcast(args.roomId, "blur", {
                    id: socket.user.id,
                    roomId: args.roomId
                });
            }
        }, this));
        mgr.on("focus", _.bind(function(socket, args) {
            var event = this.getEvent(args.roomId);
            if (event && socket.user && mgr.roomContainsSocket(args.roomId, socket)) {
                mgr.broadcast(args.roomId, "focus", {
                    id: socket.user.id,
                    roomId: args.roomId
                });
            }
        }, this));
        // Admin
        mgr.on("create-session", _.bind(function(socket, args) {
            var event = this.getEvent(args.roomId);
            if (event && socket.user && socket.user.isAdminOf(event)) {
                var newSession = new models.ServerSession({
                    title: args.title,
                    description: args.description
                });
                newSession.save();
                newSession.once("change:id", function() {
                    event.addSession(newSession);
                    // TODO: Put roomId in broadcast? Can a socket be in more than one room?
                    mgr.broadcast(args.roomId, "create-session", newSession.toJSON());
                });
                mgr.writeAck(socket, "create-session");
            } else {
                mgr.writeErr(socket, "create-session");
            }
        }, this));
        mgr.on("open-sessions", _.bind(function(socket, args) {
            var event = this.getEvent(args.roomId);
            if (event && socket.user && socket.user.isAdminOf(event)) {
                event.openSessions();
                mgr.broadcast(args.roomId, "open-sessions", {roomId: args.roomId});
                mgr.writeAck(socket, "open-sessions");
            } else {
                mgr.writeErr(socket, "open-sessions")
            }
        }, this));
        mgr.on("close-sessions", _.bind(function(socket, args) {
            var event = this.getEvent(args.roomId);
            if (event && socket.user && socket.user.isAdminOf(event)) {
                event.closeSessions();
                mgr.broadcast(args.roomId, "close-sessions", {roomId: args.roomId});
                mgr.writeAck(socket, "close-sessions");
            } else {
                mgr.writeErr(socket, "close-sessions");
            }
        }, this));
        // TODO: rename this "delete-session"
        mgr.on("delete", _.bind(function(socket, args) {
            var event = this.getEvent(args.roomId);
            if (event && socket.user && socket.user.isAdminOf(event)) {
                var session = event.get("sessions").get(args.id);
                if (session) {
                    session.destroy();
                    event.removeSession(session);
                    mgr.broadcast(args.roomId, "delete", {id: args.id, roomId: args.roomId});
                    return mgr.writeAck(socket, "delete");
                }
            }
            mgr.writeErr(socket, "delete");
        }, this));
        mgr.on("embed", _.bind(function(socket, args) {
            if (!("ytId" in args)) {
                return mgr.writeErr(socket, "embed", "Missing ytId");
            }
            var event = this.getEvent(args.roomId);
            if (event && socket.user.isAdminOf(event)) {
                event.setEmbed(args.ytId);
                event.save();
                mgr.broadcast(args.roomId, "embed", {ytId: args.ytId, roomId: args.roomId});
                mgr.writeAck(socket, "embed");
            } else {
                return mgr.writeErr(socket, "embed", "Missing event or not admin");
            }
        }, this));

        //
        // Sessions (inside hangouts)
        //

        mgr.on("session/set-hangout-url", _.bind(function(socket, args) {
            var session, inSession, result;
            session = this.getSession(args.sessionId);
            if (!session) {
                return mgr.writeErr(socket, "session/set-hangout-url", "Unknown sessionId");
            }
            inSession = _.any(mgr.roomToUsers[session.getRoomId()], function(u) {
                return u.id == socket.user.id;
            });
            if (!inSession) {
                return mgr.writeErr(socket, "session/set-connected-participants", "You are not in this session.");
            }
            result = session.setHangoutUrl(args.url);
            if (result) {
                return mgr.writeAck(socket, "session/set-hangout-url");
            } else {
                return mgr.writeErr(socket, "session/set-hangout-url", {
                    url: session.get("hangout-url")
               });
            }
        }, this));
        mgr.on("session/set-connected-participants", _.bind(function(socket, args) {
            var session, inSession;
            session = this.getSession(args.sessionId);
            if (!session) {
                return mgr.writeErr(socket, "session/set-connected-participants", "Unknown sessionId");
            }
            inSession = _.any(mgr.roomToUsers[session.getRoomId()], function(u) {
                return u.id == socket.user.id;
            });
            if (!inSession) {
                return mgr.writeErr(socket, "session/set-connected-participants", "You are not in this session.");
            }
            session.setConnectedParticipants(args.connectedParticipants);
        }, this));

        //
        // Handle broadcast requests from events.
        //
        this.db.events.on("broadcast", function(event, type, data) {
            mgr.broadcast(event.getRoomId(), type, data);
        });

        this.mgr = mgr;
    },
    shutdown: function(callback) {
        this.mgr.destroy();
        this.sockjs = null;
        callback();
    },
    getEvent: function(roomId) {
        var match = /event\/(\d+)/.exec(roomId)
        if (match) {
            var id = parseInt(match[1]);
            var event = this.db.events.get(id);
            return event;
        }
        return null;
    },
    getSession: function(roomId) {
        var match = /session\/(\d+)/.exec(roomId);
        var sessionId;
        if (match) {
            sessionId = parseInt(match[1]);
        } else {
            sessionId = parseInt(roomId);
        }
        var permalinkSession = this.db.permalinkSessions.get(sessionId);
        if (permalinkSession) {
            return permalinkSession;
        } else {
            return this.db.events.getSessionById(sessionId);
        }
    }
});

exports.UnhangoutSocketManager = UnhangoutSocketManager;