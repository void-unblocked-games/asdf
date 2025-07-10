const messages = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const userListElement = document.getElementById('user-list');
const chatTitle = document.getElementById('chat-title');
const loadingSpinner = document.getElementById('loading-spinner');

const converter = new showdown.Converter({ 
    ghCodeBlocks: true,
    tasklists: true
});
let socket;
let myUserId = localStorage.getItem('userId');
let myUserVanity = localStorage.getItem('userVanity');
let userMap = new Map(); // Maps userId to { id, vanity }
let currentRecipient = null;
let typingTimeout = undefined;
let selectedUserItem = null;

let publicChatMessages = [];
let dmMessages = new Map(); // Maps userId to an array of messages

let startTimestamp = +Date.now();
let lastTimestamp = +Date.now();
let backgroundDegrees = 0;

function connect() {
    loadingSpinner.style.display = 'flex'; // Show spinner

    if (!myUserId || !myUserVanity) {
        let displayName = prompt("Please enter your display name:");
        while (!displayName || displayName.trim() === '') {
            displayName = prompt("Display name cannot be empty. Please enter your display name:");
        }
        myUserVanity = displayName.trim();
        localStorage.setItem('userVanity', myUserVanity);
        // userId will be assigned by the server on first connection
    }

    socket = new WebSocket('ws://' + window.location.host);

    socket.onopen = () => {
        console.log('WebSocket connection established.');
        loadingSpinner.style.display = 'none'; // Hide spinner on successful connection
        if (myUserId && myUserVanity) {
            socket.send(JSON.stringify({ type: 'reconnect', id: myUserId, vanity: myUserVanity }));
        } else if (myUserVanity) {
            // First connection, send vanity to server to get userId
            socket.send(JSON.stringify({ type: 'setVanity', vanity: myUserVanity }));
        }
    };

    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'userId') {
            myUserId = message.id;
            myUserVanity = message.vanity || myUserVanity; // Update vanity if provided by server
            localStorage.setItem('userId', myUserId);
            localStorage.setItem('userVanity', myUserVanity);
            console.log('My User ID:', myUserId, 'My User Vanity:', myUserVanity);
        } else if (message.type === 'userList') {
            userMap.clear();
            message.users.forEach(user => userMap.set(user.id, user));
            updateUserList(message.users);
        } else if ((message.type === 'dm' || message.type === 'chat')) {
            // Only display message if it's not from myself (my own messages are displayed immediately on send)
            if (message.sender !== myUserId) {
                displayMessage(message);
            }
        } else if (message.type === 'typing' && message.sender !== myUserId) {
            showTypingIndicator(message);
        } else if (message.type === 'stoppedTyping' && message.sender !== myUserId) {
            hideTypingIndicator(message);
        }
    };

    socket.onclose = () => {
        console.log('WebSocket connection closed. Reconnecting...');
        loadingSpinner.style.display = 'flex'; // Show spinner on disconnect/reconnect
        setTimeout(connect, 1000); // Reconnect after 1 second
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        loadingSpinner.style.display = 'none'; // Hide spinner on error
        socket.close();
    };
}

function displayMessage(message, isCached = false) {
    // Cache the message
    if (!isCached) {
        if (message.type === 'chat') {
            publicChatMessages.push(message);
        } else if (message.type === 'dm') {
            const dmKey = [message.sender, message.recipient].sort().join('-');
            if (!dmMessages.has(dmKey)) {
                dmMessages.set(dmKey, []);
            }
            dmMessages.get(dmKey).push(message);
        }
    }

    // Only display if the message belongs to the currently active chat
    const shouldDisplay = (
        (message.type === 'chat' && currentRecipient === null) ||
        (message.type === 'dm' && (
            (message.sender === myUserId && message.recipient === currentRecipient) ||
            (message.recipient === myUserId && message.sender === currentRecipient)
        ))
    );

    if (shouldDisplay) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message');
        if (message.sender === myUserId) {
            messageElement.classList.add('my-message');
        }

        const usernameElement = document.createElement('div');
        usernameElement.classList.add('username');
        usernameElement.textContent = message.senderVanity;
        usernameElement.dataset.userId = message.sender; // Store user ID for DM
        usernameElement.addEventListener('click', () => startDmWith(message.sender));

        const contentElement = document.createElement('div');
        contentElement.classList.add('content');
        const unsafeHtml = converter.makeHtml(message.content);
        contentElement.innerHTML = unsafeHtml;

        messageElement.appendChild(usernameElement);
        messageElement.appendChild(contentElement);

        messages.appendChild(messageElement);
        messages.scrollTop = messages.scrollHeight;
    }
}

function updateUserList(users) {
    userListElement.innerHTML = '';

    // Add Public Chat option
    const publicChatLi = document.createElement('li');
    publicChatLi.textContent = 'Public Chat';
    publicChatLi.classList.add('user-item', 'public-chat-item');
    publicChatLi.addEventListener('click', switchToPublicChat);
    userListElement.appendChild(publicChatLi);

    users.forEach(user => {
        if (user.id === myUserId) {
            return; // Skip adding the current user to the list
        }
        const li = document.createElement('li');
        li.textContent = `${user.vanity} (${user.id})`;
        li.classList.add('user-item');
        li.dataset.userId = user.id; // Store userId for DM
        li.addEventListener('click', () => startDmWith(user.id));
        userListElement.appendChild(li);
    });

    // Re-apply selection after list update
    if (currentRecipient === null) {
        selectedUserItem = document.querySelector('.public-chat-item');
    } else {
        const userItem = document.querySelector(`[data-user-id="${currentRecipient}"]`);
        if (userItem) {
            userItem.classList.add('selected');
            selectedUserItem = userItem;
        }
    }
}

function switchToPublicChat() {
    currentRecipient = null;
    chatTitle.textContent = 'Public Chat';
    messages.innerHTML = ''; // Clear messages for new chat
    if (selectedUserItem) {
        selectedUserItem.classList.remove('selected');
    }
    selectedUserItem = document.querySelector('.public-chat-item');
    if (selectedUserItem) {
        selectedUserItem.classList.add('selected');
    }

    // Display cached public chat messages
    publicChatMessages.forEach(msg => displayMessage(msg, true));
}

function startDmWith(userId) {
    currentRecipient = userId;
    chatTitle.textContent = `DM with ${getVanityFromId(userId)}`;
    messages.innerHTML = ''; // Clear messages for new chat
    if (selectedUserItem) {
        selectedUserItem.classList.remove('selected');
    }
    const userItem = document.querySelector(`[data-user-id="${userId}"]`);
    if (userItem) {
        userItem.classList.add('selected');
        selectedUserItem = userItem;
    }

    // Display cached DM messages
    const dmKey = [myUserId, currentRecipient].sort().join('-');
    if (dmMessages.has(dmKey)) {
        dmMessages.get(dmKey).forEach(msg => displayMessage(msg, true));
    }
}

function getVanityFromId(id) {
    const user = userMap.get(id);
    return user ? user.vanity : id; // Fallback to id if vanity not found
}

function getIdFromVanity(vanity) {
    for (let [id, user] of userMap.entries()) {
        if (user.vanity === vanity) {
            return id;
        }
    }
    return null; // Return null if vanity not found
}

function sendTypingStatus(isTyping) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: isTyping ? 'typing' : 'stoppedTyping', sender: myUserId, recipient: currentRecipient }));
    }
}

function showTypingIndicator(message) {
    // Only show typing indicator if it's for the current chat
    const isForPublicChat = message.type === 'typing' && !message.recipient && currentRecipient === null;
    const isForCurrentDm = message.type === 'typing' && message.recipient === myUserId && message.sender === currentRecipient;

    if (isForPublicChat || isForCurrentDm) {
        let indicator = document.getElementById(`typing-indicator-${message.sender}`);
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = `typing-indicator-${message.sender}`;
            indicator.classList.add('typing-indicator');
            indicator.textContent = `${getVanityFromId(message.sender)} is typing...`;
            messages.appendChild(indicator);
        }
        messages.scrollTop = messages.scrollHeight;
    }
}

function hideTypingIndicator(message) {
    // Only hide typing indicator if it's for the current chat
    const isForPublicChat = message.type === 'stoppedTyping' && !message.recipient && currentRecipient === null;
    const isForCurrentDm = message.type === 'stoppedTyping' && message.recipient === myUserId && message.sender === currentRecipient;

    if (isForPublicChat || isForCurrentDm) {
        const indicator = document.getElementById(`typing-indicator-${message.sender}`);
        if (indicator) {
            indicator.remove();
        }
    }
}

const sendMessage = () => {
    const content = messageInput.value;
    if (content && socket.readyState === WebSocket.OPEN) {
        let messageType = 'chat';
        let messageContent = content;
        let messageRecipient = null;

        if (content.toLowerCase().startsWith('@ai')) {
            messageType = 'aiQuery';
            messageContent = content.substring(content.toLowerCase().startsWith('@ai ') ? 4 : 3).trim();
            
        } else if (currentRecipient) {
            messageType = 'dm';
            messageRecipient = currentRecipient;
            displayMessage({
                type: 'dm',
                content: content,
                sender: myUserId,
                senderVanity: myUserVanity,
                recipient: currentRecipient,
            });
        } else {
            displayMessage({
                type: 'chat',
                content: content,
                sender: myUserId,
                senderVanity: myUserVanity,
            });
        }

        // Now send the message to the server
        const messageToSend = {
            type: messageType,
            content: messageContent,
            sender: myUserId,
            senderVanity: myUserVanity,
        };
        if (messageRecipient) {
            messageToSend.recipient = messageRecipient;
        }

        socket.send(JSON.stringify(messageToSend));
        messageInput.value = '';
        clearTimeout(typingTimeout);
        sendTypingStatus(false);
    } else if (socket.readyState !== WebSocket.OPEN) {
        console.log('WebSocket is not open. readyState: ' + socket.readyState);
    };
};

sendButton.addEventListener('click', sendMessage);

messageInput.addEventListener('input', () => {
    if (socket.readyState === WebSocket.OPEN) {
        sendTypingStatus(true);
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            sendTypingStatus(false);
        }, 1500); // Send stoppedTyping after 1.5 seconds of no input
    }
});

messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
});

const darkModeToggle = document.getElementById('dark-mode-toggle');
const darkModeIcon = darkModeToggle.querySelector('i');
const userProfileButton = document.getElementById('user-profile-button');

function updateDarkModeIcon() {
    if (document.documentElement.getAttribute('data-theme') === 'dark') {
        darkModeIcon.classList.remove('fa-sun');
        darkModeIcon.classList.add('fa-moon');
    } else {
        darkModeIcon.classList.remove('fa-moon');
        darkModeIcon.classList.add('fa-sun');
    }
}

darkModeToggle.addEventListener('click', () => {
    // Add jiggle and morph classes
    darkModeToggle.classList.add('jiggle');
    darkModeToggle.classList.add('morph');

    // Toggle dark mode
    if (document.documentElement.getAttribute('data-theme') === 'dark') {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
    }

    // After half of the morph animation, switch the icon
    setTimeout(() => {
        updateDarkModeIcon();
    }, 150);

    // After the morph animation completes, remove the morph class
    setTimeout(() => {
        darkModeToggle.classList.remove('morph');
    }, 300);

    // After the jiggle animation completes, remove the jiggle class
    setTimeout(() => {
        darkModeToggle.classList.remove('jiggle');
    }, 300);
});

// Apply theme on page load
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
    }
    updateDarkModeIcon();
});

const settingsDropdown = document.getElementById('settings-dropdown');

userProfileButton.addEventListener('click', () => {
    // Add jiggle and morph classes
    userProfileButton.classList.add('jiggle');
    userProfileButton.classList.add('morph');

    // After the morph animation completes, remove the morph class
    setTimeout(() => {
        userProfileButton.classList.remove('morph');
    }, 300);

    // After the jiggle animation completes, remove the jiggle class
    setTimeout(() => {
        userProfileButton.classList.remove('jiggle');
    }, 300);

    // Set the current display name in the input field
    newDisplayNameInput.value = myUserVanity;

    // Toggle the settings dropdown
    settingsDropdown.classList.toggle('show');
});

// Close the dropdown if the user clicks outside of it
window.addEventListener('click', (event) => {
    if (!event.target.matches('.settings-button') && !userProfileButton.contains(event.target) && !settingsDropdown.contains(event.target)) {
        if (settingsDropdown.classList.contains('show')) {
            settingsDropdown.classList.remove('show');
        }
    }
});

const saveDisplayNameButton = document.getElementById('save-display-name-button');
const newDisplayNameInput = document.getElementById('new-display-name-input');

saveDisplayNameButton.addEventListener('click', () => {
    const newVanity = newDisplayNameInput.value.trim();
    if (newVanity && newVanity !== myUserVanity) {
        myUserVanity = newVanity;
        localStorage.setItem('userVanity', myUserVanity);
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'setVanity', vanity: myUserVanity }));
        }
        alert('Display name updated!');
        settingsDropdown.classList.remove('show'); // Close dropdown after saving
    } else if (newVanity === myUserVanity) {
        alert('New display name is the same as the current one.');
    } else {
        alert('Display name cannot be empty.');
    }
});

connect();
