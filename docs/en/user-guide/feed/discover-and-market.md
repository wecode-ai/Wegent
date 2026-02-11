---
sidebar_position: 5
---

# Discover & Market

Wegent provides subscription discovery and market features, allowing users to follow public subscriptions or rent market subscriptions from others.

---

## 🔍 Discovering Public Subscriptions

### Accessing the Discover Page

1. Navigate to the **Feed** page
2. Click the **Discover** tab

### Browsing Subscriptions

The discover page displays public subscriptions in a card grid format:

#### Card Information

| Element | Description |
|---------|-------------|
| **Name** | Subscription display name |
| **Type Badge** | Collection or Execution type |
| **Description** | Brief description of the subscription |
| **Latest Execution** | Status and summary of most recent execution |
| **Follower Count** | Number of users following this subscription |
| **Creator** | Username of subscription owner |

#### Sorting Options

| Sort | Description |
|------|-------------|
| **Most Popular** | Sort by follower count |
| **Most Recent** | Sort by creation time |

#### Search Function

Enter keywords in the search box to find subscriptions:

- Search by name
- Search by description
- Press Enter to execute search

### View Execution History

Click on a subscription card to open the history dialog:

- View recent execution records
- View AI-generated summaries
- Understand the subscription's actual effectiveness

---

## ➕ Following Subscriptions

### Follow Action

1. Find an interesting subscription on the discover page
2. Click the **Follow** button
3. Button changes to **Following** state

### Effects of Following

- The subscription's execution activities appear in your timeline
- Can manage follows in the "Following" list

### Unfollow

1. Click the **Following** button
2. Button will show unfollow prompt
3. Click to confirm unfollow

---

## 📋 Managing Follows

### View Following List

1. Go to subscription management page
2. Switch to the **Following** tab

### Following List Information

| Information | Description |
|-------------|-------------|
| **Subscription Name** | Name of followed subscription |
| **Creator** | Subscription owner |
| **Follow Date** | When you started following |
| **Task Type** | Collection or Execution type |

### Management Actions

- **View Details**: Navigate to subscription detail page
- **Unfollow**: Stop following the subscription

---

## 🏪 Subscription Market

### What are Market Subscriptions

Market subscriptions are published by owners for others to rent:

- **Renters** can use the subscription's functionality
- **Renters** can customize trigger configuration
- **Renters** can use their own model
- **Prompt and Agent** are set by publisher, not visible to renters

### Accessing the Market

1. Navigate to the **Feed** page
2. Click the **Market** tab

### Browsing Market Subscriptions

The market page displays rentable subscriptions:

#### List Information

| Element | Description |
|---------|-------------|
| **Name** | Subscription display name |
| **Type Badge** | Collection or Execution type |
| **Description** | Functionality description |
| **Creator** | Publisher username |
| **Rental Count** | Total number of rentals |
| **Trigger Description** | Original trigger configuration description |

#### Sorting Options

| Sort | Description |
|------|-------------|
| **Most Rented** | Sort by rental count |
| **Most Recent** | Sort by publish time |

---

## 🔑 Renting Subscriptions

### Rental Process

1. Find a subscription you want to rent in the market
2. Click the **Rent** button
3. Configure parameters in the popup dialog
4. Click **Rent** to confirm

### Rental Configuration

#### Basic Information

| Field | Description |
|-------|-------------|
| **Display Name** | Name for the rented subscription |

#### Trigger Configuration

You can customize the trigger type:

| Trigger Type | Description |
|--------------|-------------|
| **Cron Schedule** | Use Cron expressions |
| **Fixed Interval** | Execute at fixed intervals |
| **One-time** | Execute once at specified time |

> 📖 See [Trigger Types](./trigger-types.md) for detailed information

#### Model Selection (Optional)

You can choose to use your own model:

1. Click the model selector
2. Select the model to use
3. Or keep default to use publisher's model

### Rental Notes

When renting a subscription, understand that:

- **Prompt is set by publisher**: You cannot view or modify the Prompt
- **Uses publisher's agent**: Execution uses the publisher's configured agent
- **Customizable trigger and model**: You control when to execute and which model to use

---

## 📊 Managing Rentals

### View Rental List

1. Go to subscription management page
2. Switch to the **My Rentals** tab

### Rental List Information

| Information | Description |
|-------------|-------------|
| **Rental Name** | Display name you set |
| **Source Subscription** | Original subscription name |
| **Publisher** | Original subscription owner |
| **Trigger Config** | Trigger type you configured |
| **Status** | Enabled/Disabled status |

### Management Actions

- **Edit**: Modify trigger configuration and model
- **Enable/Disable**: Control whether to execute
- **Cancel Rental**: Stop renting and delete

### Cancel Rental

1. Click the **Cancel Rental** button on the rented subscription
2. Click **Confirm** in the confirmation dialog
3. Rental relationship ends, execution records are retained

---

## 📤 Publishing to Market

### Publishing Requirements

To publish a subscription to the market:

1. Subscription must be created by you
2. Subscription configuration must be complete and functional

### Publishing Steps

1. Edit the subscription
2. Select **Market** in visibility settings
3. Save the subscription

### Effects of Publishing

- Subscription appears in market list
- Other users can rent it
- You can see rental statistics

### Unpublishing

1. Edit the subscription
2. Change visibility to **Private** or **Public**
3. Save the subscription

> ⚠️ Unpublishing doesn't affect existing rental relationships

---

## 🤝 Sharing Subscriptions

### Invite to Follow

Subscription owners can invite specific users to follow:

1. Go to subscription detail page
2. Click the **Share** button
3. Enter user ID or email
4. Send invitation

### Handling Invitations

Users who receive invitations:

1. View invitation in notifications
2. Click **Accept** or **Reject**
3. Accepting automatically follows the subscription

---

## 💡 Usage Recommendations

### Discovering Quality Subscriptions

- Follow popular subscriptions to learn best practices
- Check execution history to evaluate subscription quality
- Read descriptions to understand subscription purposes

### Choosing Between Rent and Follow

| Scenario | Recommendation |
|----------|----------------|
| Want to see others' execution results | Follow |
| Want to execute with your own configuration | Rent |
| Want to learn subscription design | Follow |
| Want to use ready-made automation solutions | Rent |

### Publishing Subscriptions

- Write clear descriptions explaining the purpose
- Ensure Prompt has good generality
- Regularly check execution effectiveness

---

## ⚠️ Common Issues

### Q1: What's the difference between following and renting?

| Feature | Follow | Rent |
|---------|--------|------|
| View execution results | ✅ | ✅ |
| Customize trigger config | ❌ | ✅ |
| Use your own model | ❌ | ✅ |
| Independent execution records | ❌ | ✅ |

### Q2: What if rented subscription source becomes unavailable?

If the original subscription is deleted or unpublished:

- Already rented subscriptions can continue to work
- But may not receive updates
- Recommend contacting publisher or finding alternatives

### Q3: How to know if a subscription is worth following/renting?

Evaluation methods:

1. Check follower/rental count
2. View recent execution history
3. Read description to understand purpose
4. Check creator's other subscriptions

---

## 🔗 Related Documentation

- [Creating Subscriptions](./creating-subscriptions.md) - Create your own subscriptions
- [Activity Timeline](./timeline.md) - View execution activities
- [Trigger Types](./trigger-types.md) - Configure trigger conditions
