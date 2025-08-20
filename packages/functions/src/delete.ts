import { Resource } from "sst";
import { Util } from "@notes/core/util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Helper function to delete a note - reduces maintenance risk by centralizing logic
const deleteNote = async (event: any) => {
  const params = {
    TableName: Resource.Notes.name,
    Key: {
      userId: event.requestContext.authorizer?.iam.cognitoIdentity.identityId,
      noteId: event?.pathParameters?.id,
    },
  };

  await dynamoDb.send(new DeleteCommand(params));
  return JSON.stringify({ status: true });
};

export const main = Util.handler(async (event) => {
  return await deleteNote(event);
});

export const main2 = Util.handler(async (event) => {
  return await deleteNote(event);
});
